import WebSocket from "ws";
import type { AudioProvider, ProviderCallbacks } from "./types.js";

interface DeepgramOptions {
  apiKey: string;
  model: string;
  language: string;
  keyterms: string[];
  diarization?: boolean;
}

interface DeepgramWord {
  start?: number;
  end?: number;
  speaker?: number;
  speaker_confidence?: number;
}

interface DeepgramResults {
  type?: string;
  start?: number;
  duration?: number;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel?: {
    alternatives?: Array<{
      transcript?: string;
      words?: DeepgramWord[];
    }>;
  };
}

export class DeepgramProvider implements AudioProvider {
  readonly name = "deepgram-nova-3";
  private socket: WebSocket | null = null;
  private queued: Buffer[] = [];
  private readonly speakerMap = new Map<number, string>();
  private pendingFinal: { startMs: number; endMs: number; text: string } | null = null;

  constructor(
    private readonly options: DeepgramOptions,
    private readonly callbacks: ProviderCallbacks,
  ) {}

  async start(): Promise<void> {
    if (!this.options.apiKey) throw new Error("DEEPGRAM_API_KEY is not configured");
    const query = new URLSearchParams({
      model: this.options.model,
      language: this.options.language,
      encoding: "linear16",
      sample_rate: "16000",
      channels: "1",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      utterances: "true",
      endpointing: "800",
    });
    if (this.options.diarization !== false) query.set("diarize_model", "latest");
    for (const keyterm of this.options.keyterms) query.append("keyterm", keyterm);

    this.socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, {
      headers: { Authorization: `Token ${this.options.apiKey}` },
    });
    this.socket.on("message", (data) => this.handleMessage(data.toString()));
    this.socket.on("error", (error) => this.callbacks.onWarning(`Deepgram: ${error.message}`));
    await new Promise<void>((resolve, reject) => {
      this.socket!.once("open", () => {
        for (const audio of this.queued) this.socket!.send(audio);
        this.queued = [];
        resolve();
      });
      this.socket!.once("error", reject);
    });
  }

  send(audio: Buffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(audio);
    else this.queued.push(Buffer.from(audio));
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once("close", resolve);
      setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) socket.close();
        resolve();
      }, 5_000).unref();
    });
    this.flushPending();
    this.socket = null;
  }

  private handleMessage(raw: string): void {
    let message: DeepgramResults;
    try {
      message = JSON.parse(raw) as DeepgramResults;
    } catch {
      return;
    }
    if (message.type !== "Results") return;
    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    if (!text) return;

    const words = alternative?.words ?? [];
    if (this.options.diarization !== false) this.emitSpeakerRuns(words);
    const fallbackStart = Math.round((message.start ?? 0) * 1000);
    const fallbackEnd = fallbackStart + Math.round((message.duration ?? 0) * 1000);
    const wordStarts = words.flatMap((word) => typeof word.start === "number" ? [word.start] : []);
    const wordEnds = words.flatMap((word) => typeof word.end === "number" ? [word.end] : []);
    const startMs = wordStarts.length ? Math.round(Math.min(...wordStarts) * 1000) : fallbackStart;
    const endMs = wordEnds.length ? Math.round(Math.max(...wordEnds) * 1000) : fallbackEnd;
    if (message.is_final) {
      if (!this.pendingFinal) {
        this.pendingFinal = { startMs, endMs, text };
      } else {
        this.pendingFinal.endMs = Math.max(this.pendingFinal.endMs, endMs);
        this.pendingFinal.text = this.joinTranscript(this.pendingFinal.text, text);
      }
      if (message.speech_final || message.from_finalize) this.flushPending();
      else this.emitInterim(this.pendingFinal.startMs, this.pendingFinal.endMs, this.pendingFinal.text);
      return;
    }

    const interimText = this.pendingFinal ? this.joinTranscript(this.pendingFinal.text, text) : text;
    this.emitInterim(this.pendingFinal?.startMs ?? startMs, endMs, interimText);
  }

  private emitInterim(startMs: number, endMs: number, text: string): void {
    this.callbacks.onText?.({ startMs, endMs: Math.max(startMs + 1, endMs), text, isFinal: false });
  }

  private flushPending(): void {
    if (!this.pendingFinal) return;
    this.callbacks.onText?.({
      startMs: this.pendingFinal.startMs,
      endMs: Math.max(this.pendingFinal.startMs + 1, this.pendingFinal.endMs),
      text: this.pendingFinal.text,
      isFinal: true,
    });
    this.pendingFinal = null;
  }

  private joinTranscript(left: string, right: string): string {
    if (!left) return right;
    if (!right) return left;
    const needsSpace = /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
    return `${left}${needsSpace ? " " : ""}${right}`;
  }

  private emitSpeakerRuns(words: DeepgramWord[]): void {
    let run: { speaker: number; start: number; end: number; confidence: number | null } | null = null;
    const flush = () => {
      if (!run) return;
      this.callbacks.onSpeaker?.({
        startMs: Math.round(run.start * 1000),
        endMs: Math.max(Math.round(run.start * 1000) + 1, Math.round(run.end * 1000)),
        speaker: this.normalizedSpeaker(run.speaker),
        confidence: run.confidence,
      });
    };

    for (const word of words) {
      if (typeof word.speaker !== "number" || typeof word.start !== "number" || typeof word.end !== "number") continue;
      if (!run || run.speaker !== word.speaker) {
        flush();
        run = {
          speaker: word.speaker,
          start: word.start,
          end: word.end,
          confidence: word.speaker_confidence ?? null,
        };
      } else {
        run.end = word.end;
        if (typeof word.speaker_confidence === "number") run.confidence = word.speaker_confidence;
      }
    }
    flush();
  }

  private normalizedSpeaker(raw: number): string {
    let label = this.speakerMap.get(raw);
    if (!label) {
      label = `講者 ${this.speakerMap.size + 1}`;
      this.speakerMap.set(raw, label);
    }
    return label;
  }
}
