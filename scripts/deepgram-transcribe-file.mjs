import "dotenv/config";
import fs from "node:fs/promises";
import path from "node:path";

const input = process.argv[2];
if (!input) throw new Error("Usage: npm run deepgram:batch -- <audio-file>");
const inputPath = path.resolve(input);
const apiKey = process.env.DEEPGRAM_API_KEY?.trim();
if (!apiKey) throw new Error("DEEPGRAM_API_KEY is not configured");

const model = process.env.DEEPGRAM_MODEL?.trim() || "nova-3";
const language = process.env.DEEPGRAM_LANGUAGE?.trim() || "zh-TW";
const keyterms = (process.env.DEEPGRAM_KEYTERMS ?? "")
  .split(",")
  .map((term) => term.trim())
  .filter(Boolean);
const query = new URLSearchParams({
  model,
  language,
  smart_format: "true",
  punctuate: "true",
  utterances: "true",
  diarize_model: "latest",
});
for (const keyterm of keyterms) query.append("keyterm", keyterm);

const audio = await fs.readFile(inputPath);
const response = await fetch(`https://api.deepgram.com/v1/listen?${query}`, {
  method: "POST",
  headers: {
    Authorization: `Token ${apiKey}`,
    "content-type": "application/octet-stream",
  },
  body: audio,
  signal: AbortSignal.timeout(15 * 60_000),
});
if (!response.ok) throw new Error(`Deepgram batch failed: ${response.status} ${await response.text()}`);
const transcript = await response.json();

const reportsDir = path.resolve("reports");
await fs.mkdir(reportsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const reportPath = path.join(reportsDir, `deepgram-${path.parse(inputPath).name}-${stamp}.json`);
await fs.writeFile(reportPath, JSON.stringify(transcript, null, 2), "utf8");

const channel = transcript.results?.channels?.[0];
const alternative = channel?.alternatives?.[0];
const words = alternative?.words ?? [];
const utterances = transcript.results?.utterances ?? [];
const speakers = new Map();
for (const utterance of utterances) {
  const label = String(utterance.speaker ?? "UNKNOWN");
  const stats = speakers.get(label) ?? { utterances: 0, durationSeconds: 0 };
  stats.utterances += 1;
  stats.durationSeconds += Math.max(0, (utterance.end ?? 0) - (utterance.start ?? 0));
  speakers.set(label, stats);
}

console.log(JSON.stringify({
  requestId: transcript.metadata?.request_id,
  model,
  language,
  durationSeconds: transcript.metadata?.duration,
  wordCount: words.length,
  utteranceCount: utterances.length,
  speakerCount: speakers.size,
  speakers: [...speakers.entries()].map(([speaker, stats]) => ({
    speaker,
    utterances: stats.utterances,
    durationSeconds: Math.round(stats.durationSeconds * 10) / 10,
  })),
  reportPath,
}, null, 2));
