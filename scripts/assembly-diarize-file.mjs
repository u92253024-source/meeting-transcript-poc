import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const input = process.argv[2];
if (!input) throw new Error("Usage: npm run diarize -- <audio-file>");
const inputPath = path.resolve(input);
const apiKey = process.env.ASSEMBLYAI_API_KEY?.trim();
if (!apiKey) throw new Error("ASSEMBLYAI_API_KEY is not configured");
const batchModel = process.env.ASSEMBLYAI_BATCH_MODEL?.trim() || "universal-3-5-pro";

const audio = await fs.readFile(inputPath);
const headers = { Authorization: apiKey };
const uploadResponse = await fetch("https://api.assemblyai.com/v2/upload", {
  method: "POST",
  headers: { ...headers, "content-type": "application/octet-stream" },
  body: audio,
});
if (!uploadResponse.ok) throw new Error(`Upload failed: ${uploadResponse.status} ${await uploadResponse.text()}`);
const { upload_url: audioUrl } = await uploadResponse.json();

const submitResponse = await fetch("https://api.assemblyai.com/v2/transcript", {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({
    audio_url: audioUrl,
    speech_models: [batchModel],
    language_code: "zh",
    speaker_labels: true,
    format_text: true,
    punctuate: true,
  }),
});
if (!submitResponse.ok) throw new Error(`Submit failed: ${submitResponse.status} ${await submitResponse.text()}`);
const submitted = await submitResponse.json();

let transcript;
const deadline = Date.now() + 10 * 60_000;
while (Date.now() < deadline) {
  const response = await fetch(`https://api.assemblyai.com/v2/transcript/${submitted.id}`, { headers });
  if (!response.ok) throw new Error(`Poll failed: ${response.status} ${await response.text()}`);
  transcript = await response.json();
  if (transcript.status === "completed") break;
  if (transcript.status === "error") throw new Error(`Transcription failed: ${transcript.error}`);
  await delay(3_000);
}
if (transcript?.status !== "completed") throw new Error("Transcription timed out after 10 minutes");

const utterances = transcript.utterances ?? [];
const speakers = new Map();
for (const utterance of utterances) {
  const label = utterance.speaker ?? "UNKNOWN";
  const current = speakers.get(label) ?? { utterances: 0, durationMs: 0 };
  current.utterances += 1;
  current.durationMs += Math.max(0, (utterance.end ?? 0) - (utterance.start ?? 0));
  speakers.set(label, current);
}

console.log(JSON.stringify({
  transcriptId: transcript.id,
  status: transcript.status,
  speechModelUsed: transcript.speech_model_used,
  requestedSpeechModel: batchModel,
  audioDurationSeconds: transcript.audio_duration,
  utteranceCount: utterances.length,
  speakerCount: speakers.size,
  speakers: [...speakers.entries()].map(([speaker, stats]) => ({
    speaker,
    utterances: stats.utterances,
    durationSeconds: Math.round(stats.durationMs / 100) / 10,
  })),
}, null, 2));
