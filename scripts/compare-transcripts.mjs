import "dotenv/config";

const [meetingId, assemblyTranscriptId] = process.argv.slice(2);
if (!meetingId || !assemblyTranscriptId) {
  throw new Error("Usage: npm run compare -- <meeting-id> <assembly-transcript-id>");
}

const apiKey = process.env.ASSEMBLYAI_API_KEY?.trim();
const accessCode = process.env.VIEW_ACCESS_CODE?.trim();
if (!apiKey || !accessCode) throw new Error("ASSEMBLYAI_API_KEY and VIEW_ACCESS_CODE must be configured");

const [localResponse, assemblyResponse] = await Promise.all([
  fetch(`http://127.0.0.1:3001/api/meetings/${meetingId}?code=${encodeURIComponent(accessCode)}`),
  fetch(`https://api.assemblyai.com/v2/transcript/${assemblyTranscriptId}`, {
    headers: { Authorization: apiKey },
  }),
]);
if (!localResponse.ok) throw new Error(`Local transcript failed: ${localResponse.status} ${await localResponse.text()}`);
if (!assemblyResponse.ok) throw new Error(`AssemblyAI transcript failed: ${assemblyResponse.status} ${await assemblyResponse.text()}`);

const local = await localResponse.json();
const assembly = await assemblyResponse.json();
const assemblyWords = assembly.words ?? [];

const comparisons = local.segments.map((segment) => {
  const words = assemblyWords.filter((word) => {
    const midpoint = ((word.start ?? 0) + (word.end ?? 0)) / 2;
    return midpoint >= segment.startMs && midpoint < segment.endMs;
  });
  return {
    startMs: segment.startMs,
    endMs: segment.endMs,
    speaker: segment.speaker,
    google: segment.text,
    assembly: words.map((word) => word.text).join(""),
  };
});

console.log(JSON.stringify({
  meetingId,
  assemblyTranscriptId,
  googleSegments: local.segments.length,
  assemblyWords: assemblyWords.length,
  comparisons,
}, null, 2));
