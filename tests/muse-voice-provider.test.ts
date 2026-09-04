import { describe, expect, it } from "vitest";
import type { SpeakerObservation } from "../src/server/alignment.js";
import { MuseVoiceProvider } from "../src/server/providers/muse-voice.js";
import type { TextObservation } from "../src/server/providers/types.js";

function createHarness(overrides: Partial<ConstructorParameters<typeof MuseVoiceProvider>[0]> = {}) {
  const text: TextObservation[] = [];
  const speakers: SpeakerObservation[] = [];
  const warnings: string[] = [];

  const provider = new MuseVoiceProvider({
    apiKey: "test-meta-key",
    model: "muse-voice-transcribe-1.0",
    mode: "DIARIZATION",
    maxSegmentMs: 30_000,
    maxSegmentCharacters: 160,
    ...overrides,
  }, {
    onText: (observation) => text.push(observation),
    onSpeaker: (observation) => speakers.push(observation),
    onWarning: (message) => warnings.push(message),
  });

  const receive = (message: unknown) => {
    provider.handleMessage(JSON.stringify(message));
  };

  return { provider, receive, text, speakers, warnings };
}

describe("MuseVoiceProvider real-time transcription", () => {
  it("processes interim and final transcripts from Muse Voice stream", () => {
    const { receive, text } = createHarness();

    // Handshake acknowledgment
    receive({ sessionId: "meta-session-12345" });

    // Speech start
    receive({ type: "speechStart", audioProcessedMs: 1000 });

    // Interim transcript
    receive({
      type: "transcript",
      transcript: "各位同仁大家早",
      final: false,
      audioProcessedMs: 2500,
    });

    expect(text).toHaveLength(1);
    expect(text[0]).toEqual({
      startMs: 1000,
      endMs: 2500,
      text: "各位同仁大家早",
      isFinal: false,
    });

    // Final transcript
    receive({
      type: "transcript",
      transcript: "各位同仁大家早安",
      final: true,
      audioProcessedMs: 3200,
    });

    const finals = text.filter((t) => t.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("各位同仁大家早安。");
    expect(finals[0].startMs).toBe(1000);
    expect(finals[0].endMs).toBe(3200);
  });

  it("automatically converts Simplified Chinese from Muse Voice to Traditional Chinese", () => {
    const { receive, text } = createHarness();

    receive({ sessionId: "meta-session-12345" });
    receive({ type: "speechStart", audioProcessedMs: 0 });

    // Interim in Simplified Chinese
    receive({
      type: "transcript",
      transcript: "这是关于教务处学分学程与微学程的讨论",
      final: false,
      audioProcessedMs: 2000,
    });

    expect(text[0].text).toBe("這是關於教務處學分學程與微學程的討論");

    // Final in Simplified Chinese
    receive({
      type: "transcript",
      transcript: "命题委员发聘作业将于下周展开",
      final: true,
      audioProcessedMs: 4000,
    });

    const finals = text.filter((t) => t.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("命題委員發聘作業將於下週展開。");
  });

  it("handles speaker diarization events and attributes them cleanly", () => {
    const { receive, speakers } = createHarness();

    receive({ sessionId: "meta-session-12345" });
    receive({ type: "speechStart", audioProcessedMs: 500 });
    receive({ type: "speaker", label: "Speaker_A", audioProcessedMs: 1500 });

    expect(speakers).toHaveLength(1);
    expect(speakers[0]).toEqual({
      startMs: 500,
      endMs: 1500,
      speaker: "講者 1",
      confidence: 1.0,
    });

    // Second speaker
    receive({ type: "speechStart", audioProcessedMs: 2000 });
    receive({ type: "speaker", label: "Speaker_B", audioProcessedMs: 3500 });

    expect(speakers).toHaveLength(2);
    expect(speakers[1]).toEqual({
      startMs: 2000,
      endMs: 3500,
      speaker: "講者 2",
      confidence: 1.0,
    });
  });

  it("flushes pending interim segment when speechComplete arrives", () => {
    const { receive, text } = createHarness();

    receive({ sessionId: "meta-session-12345" });
    receive({ type: "speechStart", audioProcessedMs: 0 });
    receive({
      type: "transcript",
      transcript: "今天討論教務會議提案",
      final: false,
      audioProcessedMs: 4000,
    });

    expect(text.filter((t) => t.isFinal)).toHaveLength(0);

    // speechComplete arrives
    receive({ type: "speechComplete", audioProcessedMs: 4500 });

    const finals = text.filter((t) => t.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("今天討論教務會議提案。");
  });

  it("safely segments continuous speech when characters exceed limit", () => {
    const { receive, text } = createHarness({ maxSegmentCharacters: 30 });

    receive({ sessionId: "meta-session-12345" });
    receive({ type: "speechStart", audioProcessedMs: 0 });

    // Send a long text exceeding 50 characters
    receive({
      type: "transcript",
      transcript: "教務處報告事項包含微學程審議學分學程設置以及命題委員發聘相關作業流程請各位師長同仁參考附件資料",
      final: false,
      audioProcessedMs: 10000,
    });

    const finals = text.filter((t) => t.isFinal);
    expect(finals.length).toBeGreaterThanOrEqual(1);
    expect(finals[0].text.endsWith("。")).toBe(true);
  });

  it("emits warning callback when server returns an error event", () => {
    const { receive, warnings } = createHarness();

    receive({
      type: "error",
      message: "Model quota exceeded or rate limit reached",
      code: 429,
    });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Muse Voice: Model quota exceeded");
  });

  it("preserves terminal question marks when utterance ends with interrogative words", () => {
    const { receive, text } = createHarness();

    receive({ sessionId: "meta-session-12345" });
    receive({ type: "speechStart", audioProcessedMs: 0 });
    receive({
      type: "transcript",
      transcript: "這個提案大家是否有其他意見呢",
      final: true,
      audioProcessedMs: 3000,
    });

    const finals = text.filter((t) => t.isFinal);
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("這個提案大家是否有其他意見呢？");
  });
});
