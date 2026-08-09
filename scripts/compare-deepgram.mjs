import fs from "node:fs/promises";
import path from "node:path";

const [meetingId, deepgramResult] = process.argv.slice(2);
if (!meetingId || !deepgramResult) {
  throw new Error("Usage: npm run compare:deepgram -- <meeting-id> <deepgram-result.json>");
}

const baseUrl = process.env.BASE_URL ?? "http://127.0.0.1:3001";
const accessCode = process.env.VIEW_ACCESS_CODE ?? "2468";
const [localResponse, deepgramRaw] = await Promise.all([
  fetch(`${baseUrl}/api/meetings/${meetingId}?code=${encodeURIComponent(accessCode)}`),
  fs.readFile(path.resolve(deepgramResult), "utf8"),
]);
if (!localResponse.ok) throw new Error(`Local transcript failed: ${localResponse.status} ${await localResponse.text()}`);
const local = await localResponse.json();
const deepgram = JSON.parse(deepgramRaw);
const words = deepgram.results?.channels?.[0]?.alternatives?.[0]?.words ?? [];

const comparisons = local.segments.map((segment) => {
  const startSeconds = segment.startMs / 1000;
  const endSeconds = segment.endMs / 1000;
  const aligned = words.filter((word) => {
    const midpoint = ((word.start ?? 0) + (word.end ?? word.start ?? 0)) / 2;
    return midpoint >= startSeconds && midpoint <= endSeconds;
  });
  return {
    startMs: segment.startMs,
    endMs: segment.endMs,
    speaker: segment.speaker,
    google: segment.text,
    deepgram: aligned.map((word) => word.punctuated_word ?? word.word ?? "").join(""),
    deepgramSpeakers: [...new Set(aligned.map((word) => word.speaker).filter((speaker) => speaker !== undefined))],
  };
});

console.log(JSON.stringify({
  meetingId,
  deepgramRequestId: deepgram.metadata?.request_id,
  googleSegments: local.segments.length,
  deepgramWords: words.length,
  comparisons,
}, null, 2));
