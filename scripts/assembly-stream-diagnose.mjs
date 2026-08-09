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
if (!input) throw new Error("Usage: npm run diagnose:assembly -- <audio-file> [--start=0] [--seconds=15]");
const inputPath = path.resolve(input);
if (!fs.existsSync(inputPath)) throw new Error(`Audio file not found: ${inputPath}`);
const apiKey = process.env.ASSEMBLYAI_API_KEY?.trim();
if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY is not configured");
const start = Number(readArgument("start", "0"));
const seconds = Number(readArgument("seconds", "15"));

const query = new URLSearchParams({
  sample_rate: "16000",
  speech_model: process.env.ASSEMBLYAI_STREAMING_MODEL ?? "whisper-rt",
  speaker_labels: "true",
  max_speakers: process.env.ASSEMBLYAI_MAX_SPEAKERS ?? "10",
  format_turns: "true",
});
if (query.get("speech_model") === "whisper-rt") query.set("language_detection", "true");
const socket = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${query}`, {
  headers: { Authorization: apiKey },
});

const stats = {
  messageTypes: {},
  turns: 0,
  endOfTurns: 0,
  turnsWithSpeaker: 0,
  words: 0,
  finalWords: 0,
  wordsWithSpeaker: 0,
  observedSpeakers: new Set(),
  appliedConfiguration: null,
  termination: null,
  error: null,
};
socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  const type = message.type ?? "UNKNOWN";
  stats.messageTypes[type] = (stats.messageTypes[type] ?? 0) + 1;
  if (type === "Begin") stats.appliedConfiguration = message.configuration ?? null;
  if (type === "Termination") stats.termination = {
    audioDurationSeconds: message.audio_duration_seconds,
    sessionDurationSeconds: message.session_duration_seconds,
  };
  if (type === "Error") stats.error = { code: message.error_code, message: message.error };
  if (type !== "Turn") return;
  stats.turns += 1;
  if (message.end_of_turn) stats.endOfTurns += 1;
  if (message.speaker_label && message.speaker_label !== "UNKNOWN") {
    stats.turnsWithSpeaker += 1;
    stats.observedSpeakers.add(message.speaker_label);
  }
  for (const word of message.words ?? []) {
    stats.words += 1;
    if (word.word_is_final) stats.finalWords += 1;
    const speaker = word.speaker ?? word.speaker_label;
    if (speaker && speaker !== "UNKNOWN") {
      stats.wordsWithSpeaker += 1;
      stats.observedSpeakers.add(speaker);
    }
  }
});
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});

const ffmpegArguments = ["-hide_banner", "-loglevel", "error"];
if (start > 0) ffmpegArguments.push("-ss", String(start));
ffmpegArguments.push("-i", inputPath, "-t", String(seconds), "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1");
const ffmpeg = spawn("ffmpeg", ffmpegArguments, { stdio: ["ignore", "pipe", "pipe"] });
const bytesPerSecond = 32_000;
const startedAt = performance.now();
let sentBytes = 0;
let pending = Buffer.alloc(0);
for await (const chunk of ffmpeg.stdout) {
  pending = Buffer.concat([pending, chunk]);
  while (pending.length >= 1_600) {
    const frame = pending.subarray(0, 1_600);
    pending = pending.subarray(1_600);
    sentBytes += frame.length;
    const waitMs = sentBytes / bytesPerSecond * 1000 - (performance.now() - startedAt);
    if (waitMs > 0) await delay(waitMs);
    socket.send(frame);
  }
}
if (pending.length) socket.send(pending);
await delay(1_000);
socket.send(JSON.stringify({ type: "Terminate" }));
await Promise.race([
  new Promise((resolve) => socket.once("close", resolve)),
  delay(30_000),
]);
if (socket.readyState !== WebSocket.CLOSED) socket.close();

console.log(JSON.stringify({
  inputStartSeconds: start,
  audioSeconds: Math.round(sentBytes / bytesPerSecond),
  ...stats,
  observedSpeakers: [...stats.observedSpeakers],
}, (_key, value) => value instanceof Set ? [...value] : value, 2));
