import type { AudioProvider, ProviderCallbacks } from "./types.js";

const phrases = [
  "我們先確認今天會議的主要目標。",
  "第一個議題是中文辨識的準確率。",
  "現場收音品質會直接影響辨識結果。",
  "講者標籤在會議中先視為暫定。",
  "會議結束後再以完整錄音重新整理。",
  "校訂內容需要保留原意與時間戳。",
];

export class MockProvider implements AudioProvider {
  readonly name = "mock";
  private lastEmissionMs = 0;
  private phraseIndex = 0;

  constructor(private readonly callbacks: ProviderCallbacks) {}

  async start(): Promise<void> {}

  send(_audio: Buffer, audioPositionMs: number): void {
    if (audioPositionMs - this.lastEmissionMs < 1_600) return;
    const startMs = this.lastEmissionMs;
    const endMs = audioPositionMs;
    const text = phrases[this.phraseIndex % phrases.length];
    const speakerNumber = (Math.floor(this.phraseIndex / 2) % 3) + 1;
    this.callbacks.onText?.({ startMs, endMs, text: text.slice(0, Math.max(4, text.length - 3)), isFinal: false });
    this.callbacks.onSpeaker?.({
      startMs,
      endMs,
      speaker: `講者 ${speakerNumber}`,
      confidence: 0.9,
    });
    this.callbacks.onText?.({ startMs, endMs, text, isFinal: true });
    this.lastEmissionMs = endMs;
    this.phraseIndex += 1;
  }

  async stop(): Promise<void> {}
}
