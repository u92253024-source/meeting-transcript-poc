import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
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

  it("does not repeat committed text as cumulative partials continue", () => {
    const { receive, text } = createHarness({ maxSegmentCharacters: 30 });

    receive({ sessionId: "meta-session-12345" });
    receive({ type: "speechStart", audioProcessedMs: 0 });

    // partialMode is CUMULATIVE, so every partial repeats the whole turn so far.
    // Once a partial trips the character limit the rest must not resend what was stored.
    const spoken = "教務處報告事項包含微學程審議學分學程設置以及命題委員發聘相關作業流程請各位師長同仁參考附件資料";
    for (let length = 10; length <= spoken.length; length += 5) {
      receive({
        type: "transcript",
        transcript: spoken.slice(0, length),
        final: false,
        audioProcessedMs: length * 100,
      });
    }
    receive({ type: "transcript", transcript: spoken, final: true, audioProcessedMs: 10_000 });

    const finals = text.filter((observation) => observation.isFinal);
    expect(finals.length).toBeLessThanOrEqual(3);
    expect(finals.map((observation) => observation.text).join("").replace(/。/gu, "")).toBe(spoken);
  });

  it("clears committed text between turns so a repeated opening is kept", () => {
    const { receive, text } = createHarness({ maxSegmentCharacters: 12 });

    receive({ sessionId: "meta-session-12345" });
    receive({ type: "speechStart", audioProcessedMs: 0 });
    receive({
      type: "transcript",
      transcript: "教務處報告事項包含微學程審議",
      final: false,
      audioProcessedMs: 2000,
    });
    receive({ type: "speechComplete", audioProcessedMs: 2500 });

    // The next turn opens with the same words; it must not read as already sent.
    receive({ type: "speechStart", audioProcessedMs: 3000 });
    receive({
      type: "transcript",
      transcript: "教務處報告事項包含微學程審議完畢",
      final: true,
      audioProcessedMs: 5000,
    });

    const finals = text.filter((observation) => observation.isFinal);
    expect(finals).toHaveLength(2);
    expect(finals[1].text).toBe("教務處報告事項包含微學程審議完畢。");
    expect(finals[1].startMs).toBe(3000);
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

describe("MuseVoiceProvider session recovery", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function waitFor(check: () => boolean, label: string): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  /** Stands in for the service: acknowledges the handshake and hangs up on endStream. */
  async function startFakeService() {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    const sessions: WebSocket[] = [];
    const state = { audioBytes: 0 };

    server.on("connection", (socket) => {
      sessions.push(socket);
      socket.on("message", (data, isBinary) => {
        if (isBinary) {
          state.audioBytes += (data as Buffer).length;
          return;
        }
        if (data.toString().includes("endStream")) return socket.close(1000, "bye");
        socket.send(JSON.stringify({ sessionId: `session-${sessions.length}` }));
      });
    });

    return {
      sessions,
      state,
      url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it("reconnects after the server drops the session and keeps the meeting clock", async () => {
    const service = await startFakeService();
    const text: TextObservation[] = [];
    const warnings: string[] = [];
    const provider = new MuseVoiceProvider({
      apiKey: "test-meta-key",
      model: "muse-voice-transcribe-1.0",
      realtimeUrl: service.url,
    }, {
      onText: (observation) => text.push(observation),
      onSpeaker: () => undefined,
      onWarning: (message) => warnings.push(message),
    });
    cleanups.push(async () => {
      await provider.stop();
      await service.close();
    });

    await provider.start();
    await waitFor(() => service.sessions.length === 1, "first session");

    // 100 ms of 16 kHz mono 16-bit PCM. Waiting for the service to receive it proves
    // the handshake was acknowledged, so the meeting is 60 s in when the line drops.
    const chunk = Buffer.alloc(3_200);
    provider.send(chunk, 60_000);
    await waitFor(() => service.state.audioBytes >= chunk.length, "live audio");

    service.sessions[0].close(1011, "session expired");
    await waitFor(() => warnings.some((message) => message.includes("連線中斷")), "disconnect warning");

    // Audio recorded during the outage is bridged into the replacement session.
    // Waiting for that bridge to land proves the new handshake was acknowledged.
    const bridgedAt = service.state.audioBytes + chunk.length;
    provider.send(chunk, 61_000);
    await waitFor(() => service.sessions.length === 2, "reconnected session");
    await waitFor(() => service.state.audioBytes >= bridgedAt, "bridged audio");

    // The replacement session numbers its own audio from zero again.
    service.sessions[1].send(JSON.stringify({
      type: "transcript",
      transcript: "第三個問題是關於學分學程",
      final: true,
      audioProcessedMs: 1_500,
    }));
    await waitFor(() => text.some((observation) => observation.isFinal), "transcript after reconnect");

    const final = text.filter((observation) => observation.isFinal).at(-1)!;
    expect(final.text).toBe("第三個問題是關於學分學程。");
    // 60.9 s of bridged audio plus 1.5 s inside the new session — not 1.5 s from zero.
    expect(final.endMs).toBe(62_400);
  });

  it("bounds the audio held while the session is down", async () => {
    const service = await startFakeService();
    const warnings: string[] = [];
    const provider = new MuseVoiceProvider({
      apiKey: "test-meta-key",
      model: "muse-voice-transcribe-1.0",
      realtimeUrl: service.url,
    }, {
      onText: () => undefined,
      onSpeaker: () => undefined,
      onWarning: (message) => warnings.push(message),
    });
    cleanups.push(async () => {
      await provider.stop();
      await service.close();
    });

    await provider.start();
    await waitFor(() => service.sessions.length === 1, "first session");
    service.sessions[0].close(1011, "session expired");
    await waitFor(() => warnings.some((message) => message.includes("連線中斷")), "disconnect warning");

    // Two minutes of audio arrives while the socket is down.
    const chunk = Buffer.alloc(3_200);
    for (let positionMs = 1_000; positionMs <= 120_000; positionMs += 100) {
      provider.send(chunk, positionMs);
    }

    await waitFor(() => service.sessions.length === 2, "reconnected session");
    await waitFor(() => service.state.audioBytes > 0, "bridged audio");
    // Only the tail is replayed; the rest stays in the recording for post-processing.
    expect(service.state.audioBytes).toBeLessThanOrEqual(10_000 * 32);
  });
});
