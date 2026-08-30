import { describe, expect, it } from "vitest";
import type { SpeakerObservation } from "../src/server/alignment.js";
import { DeepgramProvider } from "../src/server/providers/deepgram.js";
import type { TextObservation } from "../src/server/providers/types.js";

function createHarness(overrides: Partial<ConstructorParameters<typeof DeepgramProvider>[0]> = {}) {
  const text: TextObservation[] = [];
  const speakers: SpeakerObservation[] = [];
  const provider = new DeepgramProvider({
    apiKey: "test",
    model: "nova-3",
    language: "zh-TW",
    keyterms: [],
    diarization: true,
    utteranceEndMs: 1_000,
    maxSegmentMs: 30_000,
    maxSegmentCharacters: 160,
    ...overrides,
  }, {
    onText: (observation) => text.push(observation),
    onSpeaker: (observation) => speakers.push(observation),
    onWarning: () => undefined,
  });
  const receive = (message: unknown) => {
    (provider as unknown as { handleMessage(raw: string): void }).handleMessage(JSON.stringify(message));
  };
  return { receive, text, speakers };
}

describe("DeepgramProvider transcript segmentation", () => {
  it("flushes finalized words when Deepgram emits UtteranceEnd without speech_final", () => {
    const { receive, text } = createHarness();
    receive({
      type: "Results",
      start: 0,
      duration: 2,
      is_final: true,
      speech_final: false,
      channel: { alternatives: [{ transcript: "這是一段完整發言", words: [] }] },
    });
    expect(text.filter((observation) => observation.isFinal)).toHaveLength(0);

    receive({ type: "UtteranceEnd", last_word_end: 2 });

    expect(text.filter((observation) => observation.isFinal).map((observation) => observation.text))
      .toEqual(["這是一段完整發言。"]);
  });

  it("forces bounded segments during continuous audio", () => {
    const { receive, text } = createHarness({ maxSegmentCharacters: 160 });
    for (let index = 0; index < 3; index += 1) {
      receive({
        type: "Results",
        start: index * 10,
        duration: 10,
        is_final: true,
        speech_final: false,
        channel: { alternatives: [{ transcript: "測".repeat(90), words: [] }] },
      });
    }
    receive({ type: "UtteranceEnd", last_word_end: 30 });

    const finals = text.filter((observation) => observation.isFinal);
    expect(finals).toHaveLength(3);
    expect(finals.map((observation) => observation.text.at(-1))).toEqual(["，", "，", "。"]);
    expect(finals.every((observation) => observation.text.length <= 161)).toBe(true);
  });

  it("splits one oversized provider result even when word metadata is unavailable", () => {
    const { receive, text } = createHarness({ maxSegmentCharacters: 160, maxSegmentMs: 30_000 });
    receive({
      type: "Results",
      start: 0,
      duration: 60,
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "長".repeat(350), words: [] }] },
    });

    const finals = text.filter((observation) => observation.isFinal);
    expect(finals).toHaveLength(3);
    expect(finals.every((observation) => observation.text.length <= 161)).toBe(true);
    expect(finals.map((observation) => observation.text.at(-1))).toEqual(["，", "，", "。"]);
  });

  it("uses punctuated words as sentence boundaries", () => {
    const { receive, text } = createHarness();
    receive({
      type: "Results",
      start: 0,
      duration: 3,
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{
        transcript: "第一句。第二句？",
        words: [
          { word: "第一句", punctuated_word: "第一句。", start: 0, end: 1.2, speaker: 0 },
          { word: "第二句", punctuated_word: "第二句？", start: 1.4, end: 3, speaker: 0 },
        ],
      }] },
    });

    expect(text.filter((observation) => observation.isFinal).map((observation) => observation.text))
      .toEqual(["第一句。", "第二句？"]);
  });

  it("splits a finalized result when the speaker changes", () => {
    const { receive, text, speakers } = createHarness();
    receive({
      type: "Results",
      start: 0,
      duration: 4,
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{
        transcript: "你好大家。接著回答問題",
        words: [
          { word: "你好", punctuated_word: "你好", start: 0, end: 0.8, speaker: 0, speaker_confidence: 0.9 },
          { word: "大家", punctuated_word: "大家。", start: 0.8, end: 1.6, speaker: 0, speaker_confidence: 0.9 },
          { word: "接著", punctuated_word: "接著", start: 2, end: 2.8, speaker: 1, speaker_confidence: 0.85 },
          { word: "回答問題", punctuated_word: "回答問題", start: 2.8, end: 4, speaker: 1, speaker_confidence: 0.85 },
        ],
      }] },
    });

    expect(text.filter((observation) => observation.isFinal).map((observation) => observation.text))
      .toEqual(["你好大家。", "接著回答問題。"]);
    expect(speakers.map((observation) => observation.speaker)).toEqual(["講者 1", "講者 2"]);
  });

  it("uses word timing gaps as a client-side utterance fallback", () => {
    const { receive, text } = createHarness();
    receive({
      type: "Results",
      start: 0,
      duration: 1,
      is_final: true,
      channel: { alternatives: [{ transcript: "第一句", words: [] }] },
    });
    receive({
      type: "Results",
      start: 3,
      duration: 1,
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "第二句", words: [] }] },
    });

    expect(text.filter((observation) => observation.isFinal).map((observation) => observation.text))
      .toEqual(["第一句。", "第二句。"]);
  });

  it("preserves provider punctuation and infers a question mark only at a true boundary", () => {
    const { receive, text } = createHarness();
    receive({
      type: "Results",
      start: 0,
      duration: 1,
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "已經完成。", words: [] }] },
    });
    receive({
      type: "Results",
      start: 2,
      duration: 1,
      is_final: true,
      speech_final: true,
      channel: { alternatives: [{ transcript: "接下來要做什麼呢", words: [] }] },
    });

    expect(text.filter((observation) => observation.isFinal).map((observation) => observation.text))
      .toEqual(["已經完成。", "接下來要做什麼呢？"]);
  });
});
