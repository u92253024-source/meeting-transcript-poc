import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";

function readArgument(name, fallback) {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const input = process.argv[2];
if (!input) {
  throw new Error("Usage: npm run replay -- <audio-file> [--start=0] [--speed=1] [--seconds=60] [--title=Replay test]");
}

const inputPath = path.resolve(input);
if (!fs.existsSync(inputPath)) throw new Error(`Audio file not found: ${inputPath}`);

const baseUrl = readArgument("base-url", "http://127.0.0.1:3001");
const title = readArgument("title", path.basename(inputPath));
const speed = Number(readArgument("speed", "1"));
const start = Number(readArgument("start", "0"));
const seconds = Number(readArgument("seconds", "0"));
const adminPassword = process.env.ADMIN_PASSWORD ?? "change-me";
if (!Number.isFinite(speed) || speed < 0) throw new Error("--speed must be 0 or a positive number");
if (!Number.isFinite(start) || start < 0) throw new Error("--start must be 0 or a positive number");
if (!Number.isFinite(seconds) || seconds < 0) throw new Error("--seconds must be 0 or a positive number");

const healthResponse = await fetch(`${baseUrl}/api/health`);
if (!healthResponse.ok) throw new Error(`Server health check failed: ${healthResponse.status}`);
const health = await healthResponse.json();
if (health.providers.mode !== "mock" && speed !== 1) {
  throw new Error("Cloud streaming must be replayed at --speed=1 to preserve provider timing");
}

const createResponse = await fetch(`${baseUrl}/api/meetings`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-admin-password": adminPassword },
  body: JSON.stringify({ title }),
});
if (!createResponse.ok) throw new Error(`Create failed: ${createResponse.status} ${await createResponse.text()}`);
const created = await createResponse.json();

const wsUrl = new URL(baseUrl.replace(/^http/, "ws"));
wsUrl.pathname = `/ws/meetings/${created.meeting.id}`;
wsUrl.searchParams.set("role", "host");
wsUrl.searchParams.set("credential", created.hostToken);
const socket = new WebSocket(wsUrl);
const warnings = [];
let segmentCount = 0;
let interimCount = 0;
let speakerUpdateCount = 0;
const speakerLabels = new Set();
const transcriptSamples = [];
const finalLatenciesMs = [];
let replayStartedAt = 0;
let sentBytes = 0;
socket.on("message", (raw) => {
  const event = JSON.parse(raw.toString());
  if (event.type === "warning") warnings.push(event.message);
  if (event.type === "interim") {
    interimCount += 1;
    if (transcriptSamples.length < 3) transcriptSamples.push(event.transcript.text);
  }
  if (event.type === "segment") {
    segmentCount += 1;
    speakerLabels.add(event.segment.speaker);
    if (speed > 0 && replayStartedAt > 0) {
      finalLatenciesMs.push(Math.max(0, performance.now() - replayStartedAt - event.segment.endMs / speed));
    }
    if (transcriptSamples.length < 3) transcriptSamples.push(event.segment.text);
  }
  if (event.type === "segment_updated") {
    speakerUpdateCount += 1;
    speakerLabels.add(event.segment.speaker);
  }
});
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

const ffmpegArguments = ["-hide_banner", "-loglevel", "error"];
if (start > 0) ffmpegArguments.push("-ss", String(start));
ffmpegArguments.push("-i", inputPath);
if (seconds > 0) ffmpegArguments.push("-t", String(seconds));
ffmpegArguments.push("-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1");
const ffmpeg = spawn("ffmpeg", ffmpegArguments, { stdio: ["ignore", "pipe", "pipe"] });
const ffmpegExit = new Promise((resolve) => ffmpeg.once("close", resolve));
let ffmpegError = "";
ffmpeg.stderr.setEncoding("utf8");
ffmpeg.stderr.on("data", (chunk) => { ffmpegError += chunk; });

const bytesPerSecond = 16_000 * 2;
replayStartedAt = performance.now();
let lastReportedMinute = -1;
let pendingAudio = Buffer.alloc(0);

async function sendFrame(frame) {
  if (socket.readyState !== WebSocket.OPEN) throw new Error("WebSocket closed during replay");
  sentBytes += frame.length;
  if (speed > 0) {
    const expectedElapsedMs = (sentBytes / bytesPerSecond / speed) * 1000;
    const waitMs = expectedElapsedMs - (performance.now() - replayStartedAt);
    if (waitMs > 0) await delay(waitMs);
  }
  while (socket.bufferedAmount > bytesPerSecond * 5) await delay(25);
  socket.send(frame);
  const audioMinute = Math.floor(sentBytes / bytesPerSecond / 60);
  if (audioMinute > lastReportedMinute) {
    lastReportedMinute = audioMinute;
    console.log(`replayedAudioMinutes=${audioMinute}`);
  }
}

try {
  for await (const chunk of ffmpeg.stdout) {
    pendingAudio = Buffer.concat([pendingAudio, chunk]);
    while (pendingAudio.length >= 1_600) {
      await sendFrame(pendingAudio.subarray(0, 1_600));
      pendingAudio = pendingAudio.subarray(1_600);
    }
  }
  if (pendingAudio.length > 0) await sendFrame(pendingAudio);

  const exitCode = await ffmpegExit;
  if (exitCode !== 0) throw new Error(`ffmpeg exited with ${exitCode}: ${ffmpegError.trim()}`);
  while (socket.bufferedAmount > 0) await delay(50);
  await delay(500);

  const stopResponse = await fetch(`${baseUrl}/api/meetings/${created.meeting.id}/stop`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-password": adminPassword },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  if (!stopResponse.ok) throw new Error(`Stop failed: ${stopResponse.status} ${await stopResponse.text()}`);
  const stopped = await stopResponse.json();
  const sortedLatencies = [...finalLatenciesMs].sort((a, b) => a - b);
  const latencyAt = (ratio) => sortedLatencies.length
    ? Math.round(sortedLatencies[Math.min(sortedLatencies.length - 1, Math.floor(sortedLatencies.length * ratio))])
    : null;
  console.log(JSON.stringify({
    meetingId: created.meeting.id,
    accessCode: created.accessCode,
    viewerUrl: `${health.providers.lanUrl ?? baseUrl}/?meeting=${created.meeting.id}`,
    input: inputPath,
    inputStartSeconds: start,
    audioSeconds: Math.round(sentBytes / bytesPerSecond),
    segmentCount,
    interimCount,
    speakerUpdateCount,
    speakerLabels: [...speakerLabels],
    transcriptSamples,
    finalLatencyMs: {
      median: latencyAt(0.5),
      p95: latencyAt(0.95),
      max: latencyAt(1),
    },
    warnings,
    mode: health.providers.mode,
    status: stopped.meeting.status,
  }, null, 2));
} finally {
  socket.close();
  if (ffmpeg.exitCode === null) ffmpeg.kill();
}
