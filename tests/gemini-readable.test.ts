import { describe, expect, it } from "vitest";
import type { TranscriptSegment } from "../src/shared/types.js";
import { generateReadableCandidates } from "../src/server/readable/gemini-readable.js";

const segments: TranscriptSegment[] = [
  { id: "s1", meetingId: "m1", startMs: 0, endMs: 1_000, text: "嗯嗯，我們今天討論預算。", speakerId: "p1", speaker: "王主任", speakerConfidence: null, createdAt: "2026-01-01T00:00:00.000Z" },
  { id: "s2", meetingId: "m1", startMs: 1_000, endMs: 2_000, text: "金額是 123 萬元。", speakerId: "p2", speaker: "李老師", speakerConfidence: null, createdAt: "2026-01-01T00:00:00.000Z" },
];

describe("Gemini readable candidates", () => {
  it("accepts structured results without making a real API request", async () => {
    let requestUrl = "";
    let requestBody: Record<string, unknown> | undefined;
    const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify([
          { segmentId: "s1", text: "我們今天討論預算。" },
          { segmentId: "s2", text: "金額是 123 萬元。" },
        ]) }]} }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const candidates = await generateReadableCandidates({ apiKey: "fake", model: "gemini-3.5-flash-lite", segments, fetchImpl: fakeFetch });
    expect(candidates.map((candidate) => candidate.text)).toEqual(["我們今天討論預算。", "金額是 123 萬元。"]);
    expect(requestUrl).toContain("models/gemini-3.5-flash-lite:generateContent");
    expect(requestBody).toMatchObject({
      generationConfig: {
        responseFormat: {
          text: {
            mimeType: "application/json",
            schema: { type: "array", items: { type: "object" } },
          },
        },
      },
    });
    expect(JSON.stringify(requestBody)).not.toContain("responseMimeType");
    expect(JSON.stringify(requestBody)).not.toContain("responseSchema");
  });

  it("falls back to the source when a number is removed", async () => {
    const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify([
        { segmentId: "s1", text: "我們今天討論預算。" },
        { segmentId: "s2", text: "金額是萬元。" },
      ]) }]} }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const candidates = await generateReadableCandidates({ apiKey: "fake", model: "gemini-3.5-flash-lite", segments, fetchImpl: fakeFetch });
    expect(candidates[1].text).toBe(segments[1].text);
  });

  it("falls back to the source when the candidate expands abnormally", async () => {
    const fakeFetch: typeof fetch = async () => new Response(JSON.stringify({
      candidates: [{ content: { parts: [{ text: JSON.stringify([
        { segmentId: "s1", text: `我們今天討論預算。${"新增內容".repeat(20)}` },
        { segmentId: "s2", text: "金額是 123 萬元。" },
      ]) }]} }],
    }), { status: 200, headers: { "content-type": "application/json" } });
    const candidates = await generateReadableCandidates({ apiKey: "fake", model: "gemini-3.5-flash-lite", segments, fetchImpl: fakeFetch });
    expect(candidates[0].text).toBe(segments[0].text);
  });
});
