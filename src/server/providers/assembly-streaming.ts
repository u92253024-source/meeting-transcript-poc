import WebSocket from "ws";
import type { AudioProvider, ProviderCallbacks } from "./types.js";

interface AssemblyTurn {
  type?: string;
  turn_order?: number;
  transcript?: string;
  end_of_turn?: boolean;
  speaker_label?: string;
  words?: Array<{
    start?: number;
    end?: number;
    speaker?: string;
    speaker_label?: string;
    word_is_final?: boolean;
  }>;
}

export class AssemblyStreamingProvider implements AudioProvider {
  readonly name = "assemblyai-streaming-v3";
  private socket: WebSocket | null = null;
  private queued: Buffer[] = [];
  private latestAudioPositionMs = 0;
  private readonly speakerMap = new Map<string, string>();
  private readonly processedTurnEndMs = new Map<number, number>();

  constructor(
    private readonly apiKey: string,
    private readonly maxSpeakers: number,
    private readonly streamingModel: string,
    private readonly callbacks: ProviderCallbacks,
  ) {}

  async start(): Promise<void> {
    if (!this.apiKey) throw new Error("ASSEMBLYAI_API_KEY 尚未設定");
    const query = new URLSearchParams({
      sample_rate: "16000",
      speech_model: this.streamingModel,
      speaker_labels: "true",
      max_speakers: String(this.maxSpeakers),
      format_turns: "true",
    });
    if (this.streamingModel === "whisper-rt") query.set("language_detection", "true");
    this.socket = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${query}`, {
      headers: { Authorization: this.apiKey },
    });
    this.socket.on("message", (data) => this.handleMessage(data.toString()));
    this.socket.on("error", (error) => this.callbacks.onWarning(`AssemblyAI：${error.message}`));
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("open", () => {
        for (const audio of this.queued) this.socket!.send(audio);
        this.queued = [];
        resolve();
      });
      this.socket!.once("error", reject);
    });
  }

  send(audio: Buffer, audioPositionMs: number): void {
    this.latestAudioPositionMs = audioPositionMs;
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(audio);
    else this.queued.push(Buffer.from(audio));
  }

  async stop(): Promise<void> {
    if (!this.socket) return;
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: "Terminate" }));
    await new Promise<void>((resolve) => {
      this.socket!.once("close", resolve);
      setTimeout(() => {
        this.socket?.close();
        resolve();
      }, 2_000).unref();
    });
    this.socket = null;
  }

  private handleMessage(raw: string): void {
    let message: AssemblyTurn;
    try {
      message = JSON.parse(raw) as AssemblyTurn;
    } catch {
      return;
    }
    if (process.env.ASSEMBLYAI_DEBUG === "true" && message.type === "Turn") {
      const words = message.words ?? [];
      console.log(JSON.stringify({
        provider: this.name,
        type: message.type,
        turnOrder: message.turn_order,
        endOfTurn: message.end_of_turn,
        wordCount: words.length,
        finalWordCount: words.filter((word) => word.word_is_final === true).length,
        turnSpeaker: message.speaker_label ?? null,
        wordSpeakers: [...new Set(words.map((word) => word.speaker ?? word.speaker_label).filter(Boolean))],
        firstStart: words.find((word) => typeof word.start === "number")?.start ?? null,
        lastEnd: [...words].reverse().find((word) => typeof word.end === "number")?.end ?? null,
      }));
    }
    if (message.type !== "Turn") return;
    const turnOrder = message.turn_order ?? 0;
    const processedEndMs = this.processedTurnEndMs.get(turnOrder) ?? -1;
    const finalWords = (message.words ?? []).filter((word) => (
      word.word_is_final !== false
      && typeof word.start === "number"
      && typeof word.end === "number"
      && word.end > processedEndMs
    ));
    if (finalWords.length === 0) return;

    let run: { rawSpeaker: string; startMs: number; endMs: number } | null = null;
    const flush = () => {
      if (!run || run.rawSpeaker === "UNKNOWN") return;
      this.callbacks.onSpeaker?.({
        startMs: run.startMs,
        endMs: Math.max(run.startMs + 1, run.endMs),
        speaker: this.normalizedSpeaker(run.rawSpeaker),
        confidence: null,
      });
    };

    for (const word of finalWords) {
      const rawSpeaker = word.speaker ?? word.speaker_label ?? message.speaker_label ?? "UNKNOWN";
      if (!run || run.rawSpeaker !== rawSpeaker) {
        flush();
        run = { rawSpeaker, startMs: word.start!, endMs: word.end! };
      } else {
        run.endMs = word.end!;
      }
    }
    flush();
    this.processedTurnEndMs.set(turnOrder, Math.max(...finalWords.map((word) => word.end!)));
  }

  private normalizedSpeaker(raw: string): string {
    let label = this.speakerMap.get(raw);
    if (!label) {
      label = `講者 ${this.speakerMap.size + 1}`;
      this.speakerMap.set(raw, label);
    }
    return label;
  }
}
