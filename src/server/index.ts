import fs from "node:fs";
import path from "node:path";
import { randomInt } from "node:crypto";
import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { z } from "zod";
import type { ProviderStatus, ServerEvent } from "../shared/types.js";
import { config } from "./config.js";
import { TranscriptDatabase } from "./database.js";
import { SpeakerTimeline } from "./alignment.js";
import { MeetingSession } from "./meeting-session.js";
import { parseByteRange } from "./audio/range.js";
import { runAssemblyBatch } from "./postprocess/assembly-batch.js";
import { estimateAssemblyCostUsd } from "./postprocess/cost.js";
import { mergeMeetingWavChunks } from "./postprocess/merge-wav.js";
import { generateTranscriptExport, type TranscriptExportFormat } from "./export/transcript-export.js";
import { generateReadableCandidates } from "./readable/gemini-readable.js";
import { AdminAuth } from "./admin-auth.js";
import { cleanupExpiredRecordings, deleteMeetingAudio, deleteMeetingData } from "./recording-retention.js";

const app = Fastify({ logger: true, bodyLimit: 1_048_576 });
const database = new TranscriptDatabase(config.dataDir);
database.backfillLegacyViewerCodes(config.legacyViewAccessCode);
const adminAuth = new AdminAuth(database, config.bootstrapAdminPassword);
const sockets = new Map<string, Set<WebSocket>>();
const sessions = new Map<string, MeetingSession>();
const hostTokens = new Map<string, string>();
const audioPreparations = new Map<string, Promise<string>>();
const webSocketServer = new WebSocketServer({ noServer: true });

const meetingInput = z.object({
  title: z.string().trim().min(1).max(120).default("未命名會議"),
});
const segmentTextInput = z.object({ text: z.string().trim().min(1).max(20_000) });
const segmentSpeakerInput = z.object({ speakerId: z.string().uuid() });
const speakerNameInput = z.object({ name: z.string().trim().min(1).max(80) });
const mergeSpeakerInput = z.object({ targetSpeakerId: z.string().uuid() });
const exportFormatInput = z.enum(["txt", "md", "docx", "pdf"]);
const readableReviewInput = z.object({ status: z.enum(["accepted", "rejected"]) });
const initialAdminPasswordInput = z.object({ password: z.string().min(12).max(256) });

function isAdmin(password: string | string[] | undefined): boolean {
  return adminAuth.verify(password);
}

function createViewerCode(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  return Array.from({ length: 8 }, () => alphabet[randomInt(alphabet.length)]).join("");
}

function getLanUrl(): string | null {
  const addresses = Object.values(networkInterfaces()).flat().filter((address): address is NetworkInterfaceInfo => (
    Boolean(address && address.family === "IPv4" && !address.internal)
  ));
  const preferred = addresses.find((address) => /^192\.168\.|^10\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(address.address)) ?? addresses[0];
  return preferred ? `http://${preferred.address}:${config.port}` : null;
}

function broadcast(meetingId: string, event: ServerEvent): void {
  const encoded = JSON.stringify(event);
  for (const socket of sockets.get(meetingId) ?? []) {
    if (socket.readyState === WebSocket.OPEN) socket.send(encoded);
  }
}

app.get("/api/health", async () => {
  const providers: ProviderStatus = {
    mode: config.mode,
    cloudSttConfigured: Boolean(config.google.project),
    assemblyAiConfigured: Boolean(config.assembly.apiKey),
    deepgramConfigured: Boolean(config.deepgram.apiKey),
    geminiConfigured: Boolean(config.gemini.apiKey),
    readableModel: config.gemini.readableModel,
    adminPasswordConfigured: adminAuth.isConfigured,
    recordingRetentionDays: config.recordingRetentionDays,
    lanUrl: getLanUrl(),
  };
  return { ok: true, providers };
});

app.get("/api/setup-status", async () => ({ adminPasswordConfigured: adminAuth.isConfigured }));

// Electron uses this endpoint before it accepts a change to its encrypted
// provider settings.  It deliberately returns no secret or account details.
app.post("/api/admin/verify", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) {
    return reply.code(401).send({ error: "管理密碼錯誤" });
  }
  return { ok: true };
});

app.post("/api/setup/admin-password", async (request, reply) => {
  if (adminAuth.isConfigured) return reply.code(409).send({ error: "管理密碼已設定；請在管理介面變更" });
  const input = initialAdminPasswordInput.parse(request.body ?? {});
  adminAuth.configure(input.password);
  return reply.code(201).send({ adminPasswordConfigured: true });
});

app.post("/api/meetings", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const input = meetingInput.parse(request.body ?? {});
  const accessCode = createViewerCode();
  const meeting = database.createMeeting(input.title, accessCode);
  const hostToken = crypto.randomUUID();
  hostTokens.set(meeting.id, hostToken);
  const session = new MeetingSession(meeting.id, database, (event) => broadcast(meeting.id, event));
  sessions.set(meeting.id, session);
  try {
    await session.start();
  } catch {
    sessions.delete(meeting.id);
    hostTokens.delete(meeting.id);
    database.stopMeeting(meeting.id);
    return reply.code(503).send({ error: "轉錄服務無法啟動，請檢查設定或改用 mock 模式" });
  }
  return reply.code(201).send({ meeting, accessCode, hostToken });
});

app.get("/api/meetings/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { code } = request.query as { code?: string };
  if (!database.hasValidViewerCode(id, code ?? "")) return reply.code(401).send({ error: "會議存取碼錯誤" });
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  return {
    meeting,
    segments: database.listSegments(id),
    speakers: database.listSpeakers(id),
    readableVariants: database.listReadableVariants(id),
  };
});

app.get("/api/meetings/:id/audio", async (request, reply) => {
  const { id } = request.params as { id: string };
  const { code } = request.query as { code?: string };
  if (!database.hasValidViewerCode(id, code ?? "")) return reply.code(401).send({ error: "會議存取碼錯誤" });
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "會議結束後才可播放錄音" });
  if (meeting.recording.audioDeletedAt) return reply.code(410).send({ error: "錄音已依保存政策刪除" });

  const audioPath = await ensurePlaybackAudio(id);
  const stat = await fs.promises.stat(audioPath);
  const range = parseByteRange(request.headers.range, stat.size);
  reply.header("accept-ranges", "bytes").type("audio/wav");
  if (range === "invalid") {
    return reply.header("content-range", `bytes */${stat.size}`).code(416).send();
  }
  if (range) {
    const length = range.end - range.start + 1;
    reply.header("content-range", `bytes ${range.start}-${range.end}/${stat.size}`);
    reply.header("content-length", String(length));
    return reply.code(206).send(fs.createReadStream(audioPath, range));
  }
  reply.header("content-length", String(stat.size));
  return reply.send(fs.createReadStream(audioPath));
});

app.get("/api/meetings/:id/export/:format", async (request, reply) => {
  const { id, format: rawFormat } = request.params as { id: string; format: string };
  const { code, version } = request.query as { code?: string; version?: string };
  if (!database.hasValidViewerCode(id, code ?? "")) return reply.code(401).send({ error: "會議存取碼錯誤" });
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "會議結束後才可匯出逐字稿" });
  const parsedFormat = exportFormatInput.safeParse(rawFormat);
  if (!parsedFormat.success) return reply.code(400).send({ error: "不支援的匯出格式" });
  const format = parsedFormat.data as TranscriptExportFormat;
  const requestDirectory = path.join(config.dataDir, "meetings", id, "exports", crypto.randomUUID());
  const edition = version === "readable" ? "readable" : "verbatim";
  const segments = edition === "readable" ? database.listReadableSegments(id) : database.listSegments(id);
  const result = await generateTranscriptExport({ meeting, segments, edition }, format, requestDirectory);
  const cleanup = () => void fs.promises.rm(requestDirectory, { recursive: true, force: true });
  reply.raw.once("finish", cleanup);
  reply.raw.once("close", cleanup);
  reply.type(result.contentType);
  reply.header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(result.downloadName)}`);
  return reply.send(fs.createReadStream(result.filePath));
});

app.delete("/api/meetings/:id/audio", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const { id } = request.params as { id: string };
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "請先結束會議，再刪除錄音" });
  if (meeting.recording.audioDeletedAt) return reply.code(409).send({ error: "錄音已刪除" });
  if (meeting.postprocess.status === "queued" || meeting.postprocess.status === "processing") {
    return reply.code(409).send({ error: "會後講者修正進行中，暫時不能刪除錄音" });
  }
  if (!await deleteMeetingAudio(database, config.dataDir, id)) return reply.code(409).send({ error: "錄音狀態已變更，請重新整理" });
  audioPreparations.delete(id);
  const updated = database.getMeeting(id)!;
  broadcast(id, { type: "meeting_updated", meeting: updated });
  return { meeting: updated };
});

app.delete("/api/meetings/:id", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const { id } = request.params as { id: string };
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "請先結束會議，再刪除整場資料" });
  if (meeting.postprocess.status === "queued" || meeting.postprocess.status === "processing" || meeting.readable.status === "processing") {
    return reply.code(409).send({ error: "背景處理進行中，暫時不能刪除整場資料" });
  }
  await deleteMeetingData(config.dataDir, id);
  if (!database.deleteMeeting(id)) return reply.code(409).send({ error: "會議狀態已變更，請重新整理" });
  audioPreparations.delete(id);
  hostTokens.delete(id);
  for (const socket of sockets.get(id) ?? []) socket.close(1000, "meeting deleted");
  sockets.delete(id);
  return { deleted: true };
});

app.post("/api/meetings/:id/readable", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const { id } = request.params as { id: string };
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "會議結束後才可產生易讀版" });
  if (!config.gemini.apiKey) return reply.code(503).send({ error: "GEMINI_API_KEY 尚未設定" });
  const segments = database.listSegments(id);
  if (segments.length === 0) return reply.code(400).send({ error: "沒有可處理的逐字稿" });
  const characterCount = segments.reduce((total, segment) => total + segment.text.length, 0);
  const processing = database.beginReadableGeneration(id, characterCount, config.gemini.readableModel);
  if (!processing) return reply.code(409).send({ error: "易讀版正在產生中", meeting: database.getMeeting(id) });
  broadcast(id, { type: "meeting_updated", meeting: processing });
  setImmediate(() => void processReadableTranscript(id));
  return reply.code(202).send({ meeting: processing });
});

app.patch("/api/meetings/:id/readable/:variantId", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const { id, variantId } = request.params as { id: string; variantId: string };
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到此會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "請先結束會議，再審核易讀逐字稿" });
  const input = readableReviewInput.parse(request.body ?? {});
  const variant = database.reviewReadableVariant(id, variantId, input.status);
  if (!variant) return reply.code(409).send({ error: "易讀候選稿已過期或不存在，請重新產生" });
  const variants = database.listReadableVariants(id);
  broadcast(id, { type: "readable_variants_updated", variants });
  return { variant, variants };
});

app.patch("/api/meetings/:id/segments/:segmentId", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const { id, segmentId } = request.params as { id: string; segmentId: string };
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "會議結束後才可校訂" });
  const input = segmentTextInput.parse(request.body ?? {});
  const segment = database.updateSegmentText(id, segmentId, input.text);
  if (!segment) return reply.code(404).send({ error: "找不到逐字稿段落" });
  broadcast(id, { type: "segment_updated", segment });
  return { segment };
});

app.patch("/api/meetings/:id/segments/:segmentId/speaker", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const { id, segmentId } = request.params as { id: string; segmentId: string };
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "會議結束後才可重新指派講者" });
  const input = segmentSpeakerInput.parse(request.body ?? {});
  const segment = database.assignSegmentSpeaker(id, segmentId, input.speakerId);
  if (!segment) return reply.code(404).send({ error: "找不到逐字稿段落或講者" });
  broadcast(id, { type: "segment_updated", segment });
  return { segment };
});

app.post("/api/meetings/:id/speakers", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const { id } = request.params as { id: string };
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "會議結束後才可新增講者" });
  const input = speakerNameInput.parse(request.body ?? {});
  const speaker = database.createSpeaker(id, input.name);
  const speakers = database.listSpeakers(id);
  broadcast(id, { type: "speakers_updated", speakers });
  return reply.code(201).send({ speaker, speakers });
});

app.patch("/api/meetings/:id/speakers/:speakerId", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const { id, speakerId } = request.params as { id: string; speakerId: string };
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "會議結束後才可修改講者" });
  if (meeting.postprocess.status === "queued" || meeting.postprocess.status === "processing") {
    return reply.code(409).send({ error: "請等待會後講者修正完成再改姓名" });
  }
  const input = speakerNameInput.parse(request.body ?? {});
  const updated = database.renameSpeaker(id, speakerId, input.name);
  if (!updated) return reply.code(404).send({ error: "找不到講者" });
  for (const segment of updated.segments) broadcast(id, { type: "segment_updated", segment });
  const speakers = database.listSpeakers(id);
  broadcast(id, { type: "speakers_updated", speakers });
  return { ...updated, speakers };
});

app.post("/api/meetings/:id/speakers/:speakerId/merge", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const { id, speakerId } = request.params as { id: string; speakerId: string };
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "會議結束後才可合併講者" });
  const input = mergeSpeakerInput.parse(request.body ?? {});
  const segments = database.mergeSpeakers(id, speakerId, input.targetSpeakerId);
  if (!segments) return reply.code(404).send({ error: "找不到來源或目標講者" });
  for (const segment of segments) broadcast(id, { type: "segment_updated", segment });
  const speakers = database.listSpeakers(id);
  broadcast(id, { type: "speakers_updated", speakers });
  return { segments, speakers };
});

app.post("/api/meetings/:id/stop", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const { id } = request.params as { id: string };
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  const session = sessions.get(id);
  const audioDurationMs = session ? await session.stop() : meeting.postprocess.audioDurationMs;
  sessions.delete(id);
  hostTokens.delete(id);
  const estimatedCostUsd = estimateAssemblyCostUsd(
    audioDurationMs,
    config.assembly.batchBaseUsdPerHour,
    config.assembly.diarizationUsdPerHour,
  );
  const stopped = database.stopMeeting(id, audioDurationMs, estimatedCostUsd)!;
  broadcast(id, { type: "status", status: "stopped" });
  broadcast(id, { type: "meeting_updated", meeting: stopped });
  return { meeting: stopped };
});

app.post("/api/meetings/:id/postprocess", async (request, reply) => {
  if (!isAdmin(request.headers["x-admin-password"])) return reply.code(401).send({ error: "管理密碼錯誤" });
  const { id } = request.params as { id: string };
  const meeting = database.getMeeting(id);
  if (!meeting) return reply.code(404).send({ error: "找不到會議" });
  if (meeting.status !== "stopped") return reply.code(409).send({ error: "請先結束會議" });
  if (meeting.recording.audioDeletedAt) return reply.code(410).send({ error: "錄音已依保存政策刪除，無法進行會後講者修正" });
  if (meeting.postprocess.audioDurationMs <= 0) return reply.code(400).send({ error: "錄音長度為零，無法進行會後修正" });
  if (!config.assembly.apiKey) return reply.code(503).send({ error: "AssemblyAI API key 尚未設定" });

  const queued = database.queuePostprocess(id);
  if (!queued) {
    return reply.code(409).send({
      error: "會後講者修正已送出或已完成，未重複上傳",
      meeting: database.getMeeting(id),
    });
  }
  broadcast(id, { type: "meeting_updated", meeting: queued });
  setImmediate(() => void processMeetingSpeakers(id));
  return reply.code(202).send({ meeting: queued });
});

async function processMeetingSpeakers(meetingId: string): Promise<void> {
  const processing = database.markPostprocessProcessing(meetingId);
  if (processing) broadcast(meetingId, { type: "meeting_updated", meeting: processing });
  try {
    const audioPath = await ensurePlaybackAudio(meetingId);
    const result = await runAssemblyBatch({
      apiKey: config.assembly.apiKey,
      model: config.assembly.batchModel,
      audioPath,
    });
    if (result.utterances.length === 0) throw new Error("AssemblyAI 未產生任何講者段落");

    const speakerNames = new Map<string, string>();
    const timeline = new SpeakerTimeline();
    for (const utterance of [...result.utterances].sort((a, b) => a.start - b.start)) {
      if (!speakerNames.has(utterance.speaker)) {
        speakerNames.set(utterance.speaker, `講者 ${speakerNames.size + 1}`);
      }
      timeline.add({
        startMs: utterance.start,
        endMs: utterance.end,
        speaker: speakerNames.get(utterance.speaker)!,
        confidence: utterance.confidence,
      });
    }
    for (const segment of database.listSegments(meetingId)) {
      const match = timeline.findForRange(segment.startMs, segment.endMs);
      if (!match) continue;
      const updated = database.updateSegmentSpeaker(segment.id, match.speaker, match.confidence);
      if (updated) broadcast(meetingId, { type: "segment_updated", segment: updated });
    }
    const completed = database.completePostprocess(meetingId, result.transcriptId);
    if (completed) broadcast(meetingId, { type: "meeting_updated", meeting: completed });
    broadcast(meetingId, { type: "speakers_updated", speakers: database.listSpeakers(meetingId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = database.failPostprocess(meetingId, message);
    if (failed) broadcast(meetingId, { type: "meeting_updated", meeting: failed });
    broadcast(meetingId, { type: "warning", message: `會後講者修正失敗：${message}` });
  }
}

async function processReadableTranscript(meetingId: string): Promise<void> {
  try {
    const segments = database.listSegments(meetingId);
    const candidates = await generateReadableCandidates({
      apiKey: config.gemini.apiKey,
      model: config.gemini.readableModel,
      segments,
    });
    const variants = database.saveReadableVariants(meetingId, config.gemini.readableModel, candidates);
    broadcast(meetingId, { type: "readable_variants_updated", variants });
    const completed = database.completeReadableGeneration(meetingId);
    if (completed) broadcast(meetingId, { type: "meeting_updated", meeting: completed });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = database.failReadableGeneration(meetingId, message);
    if (failed) broadcast(meetingId, { type: "meeting_updated", meeting: failed });
    broadcast(meetingId, { type: "warning", message: `易讀版產生失敗：${message}` });
  }
}

async function ensurePlaybackAudio(meetingId: string): Promise<string> {
  const existing = audioPreparations.get(meetingId);
  if (existing) return existing;
  const preparation = (async () => {
    const audioDirectory = path.join(config.dataDir, "meetings", meetingId, "audio");
    const merged = await mergeMeetingWavChunks(audioDirectory);
    return merged.outputPath;
  })();
  audioPreparations.set(meetingId, preparation);
  try {
    return await preparation;
  } catch (error) {
    audioPreparations.delete(meetingId);
    throw error;
  }
}


const webRoot = path.resolve(process.env.APP_ROOT || process.cwd(), "dist-web");
if (fs.existsSync(webRoot)) {
  await app.register(fastifyStatic, { root: webRoot });
  app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
}

app.server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const match = /^\/ws\/meetings\/([^/]+)$/.exec(url.pathname);
  if (!match) return socket.destroy();
  const meetingId = match[1];
  const role = url.searchParams.get("role") ?? "viewer";
  const credential = url.searchParams.get("credential") ?? "";
  const allowed = role === "host" ? credential === hostTokens.get(meetingId) : database.hasValidViewerCode(meetingId, credential);
  if (!allowed || !database.getMeeting(meetingId)) return socket.destroy();
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    connectMeetingSocket(webSocket, meetingId, role);
  });
});

function connectMeetingSocket(socket: WebSocket, meetingId: string, role: string): void {
  const meetingSockets = sockets.get(meetingId) ?? new Set<WebSocket>();
  meetingSockets.add(socket);
  sockets.set(meetingId, meetingSockets);
  const meeting = database.getMeeting(meetingId)!;
  socket.send(JSON.stringify({
    type: "ready",
    meeting,
    segments: database.listSegments(meetingId),
    speakers: database.listSpeakers(meetingId),
    readableVariants: database.listReadableVariants(meetingId),
  } satisfies ServerEvent));

  socket.on("message", (data: RawData, isBinary: boolean) => {
    if (!isBinary || role !== "host" || meeting.status !== "recording") return;
    const session = sessions.get(meetingId);
    if (!session) return;
    void session.ingestAudio(Buffer.from(data as ArrayBuffer)).catch((error: Error) => {
      broadcast(meetingId, { type: "warning", message: `音訊寫入失敗：${error.message}` });
    });
  });
  socket.on("close", () => {
    meetingSockets.delete(socket);
    if (meetingSockets.size === 0) sockets.delete(meetingId);
  });
}

async function shutdown(): Promise<void> {
  clearInterval(retentionTimer);
  await Promise.allSettled([...sessions.values()].map((session) => session.stop()));
  database.close();
  await app.close();
}

process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));

async function runRecordingRetention(): Promise<void> {
  try {
    const removed = await cleanupExpiredRecordings(database, config.dataDir, config.recordingRetentionDays);
    for (const meetingId of removed) {
      const meeting = database.getMeeting(meetingId);
      if (meeting) broadcast(meetingId, { type: "meeting_updated", meeting });
    }
    if (removed.length > 0) app.log.info({ meetings: removed.length }, "Expired recordings removed");
  } catch (error) {
    app.log.error(error, "Recording retention cleanup failed");
  }
}

await app.listen({ host: config.host, port: config.port });
void runRecordingRetention();
const retentionTimer = setInterval(() => void runRecordingRetention(), 6 * 60 * 60 * 1_000);
retentionTimer.unref();
