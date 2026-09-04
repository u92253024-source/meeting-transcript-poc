import WebSocket from "ws";
import * as OpenCC from "opencc-js";
import type { AudioProvider, ProviderCallbacks } from "./types.js";

export interface MuseVoiceOptions {
  apiKey: string;
  model: string;
  realtimeUrl?: string;
  mode?: "DIARIZATION" | "ENDPOINTING" | "PUSH_TO_TALK";
  maxSegmentMs?: number;
  maxSegmentCharacters?: number;
  toTraditional?: boolean;
}

export interface MuseVoiceServerMessage {
  sessionId?: string;
  type?: string;
  transcript?: string;
  final?: boolean;
  label?: string;
  audioProcessedMs?: number;
  message?: string;
  code?: number;
}

interface PendingSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export class MuseVoiceProvider implements AudioProvider {
  readonly name = "muse-voice-transcribe";
  private socket: WebSocket | null = null;
  private queued: Buffer[] = [];
  private readonly speakerMap = new Map<string, string>();
  private handshakeCompleted = false;
  private currentTurnStartMs = 0;
  private activeSpeaker: string | null = null;
  private pendingSegment: PendingSegment | null = null;
  private lastProcessedMs = 0;
  private readonly toTraditionalConverter = OpenCC.Converter({ from: "cn", to: "tw" });

  constructor(
    private readonly options: MuseVoiceOptions,
    private readonly callbacks: ProviderCallbacks,
  ) {}

  async start(): Promise<void> {
    if (!this.options.apiKey) throw new Error("MUSE_VOICE_API_KEY is not configured");
    const endpoint = this.options.realtimeUrl || "wss://api.meta.ai/v1/asr/realtime";

    this.socket = new WebSocket(endpoint);
    this.handshakeCompleted = false;

    this.socket.on("message", (data) => this.handleMessage(data.toString()));
    this.socket.on("error", (error) => this.callbacks.onWarning(`Muse Voice: ${error.message}`));

    await new Promise<void>((resolve, reject) => {
      this.socket!.once("open", () => {
        // Send initial handshake frame as the very first JSON text frame within 10s
        const handshake = {
          authorization: {
            accessToken: `Bearer ${this.options.apiKey}`,
          },
          audioEncoding: "PCM_16KHZ",
          model: this.options.model || "muse-voice-transcribe-1.0",
          mode: this.options.mode || "DIARIZATION",
          partialMode: "CUMULATIVE",
          language: "zh-TW",
        };
        this.socket!.send(JSON.stringify(handshake));
        resolve();
      });
      this.socket!.once("error", reject);
    });
  }

  send(audio: Buffer, audioPositionMs: number): void {
    this.lastProcessedMs = Math.max(this.lastProcessedMs, audioPositionMs);
    if (this.socket?.readyState === WebSocket.OPEN && this.handshakeCompleted) {
      this.socket.send(audio);
    } else {
      this.queued.push(Buffer.from(audio));
    }
  }

  async stop(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: "endStream" }));
    }
    await new Promise<void>((resolve) => {
      if (socket.readyState === WebSocket.CLOSED) return resolve();
      socket.once("close", resolve);
      setTimeout(() => {
        if (socket.readyState !== WebSocket.CLOSED) socket.close();
        resolve();
      }, 5_000).unref();
    });
    this.flushPendingSegment();
    this.socket = null;
  }

  handleMessage(raw: string): void {
    let message: MuseVoiceServerMessage;
    try {
      message = JSON.parse(raw) as MuseVoiceServerMessage;
    } catch {
      return;
    }

    // Handshake acknowledgment: server returns sessionId (often with no type field)
    if (message.sessionId && (!message.type || message.type === "session.ready")) {
      this.handshakeCompleted = true;
      if (this.socket?.readyState === WebSocket.OPEN) {
        for (const chunk of this.queued) this.socket.send(chunk);
      }
      this.queued = [];
      return;
    }

    if (message.type === "speechStart") {
      this.currentTurnStartMs = message.audioProcessedMs ?? this.lastProcessedMs;
      return;
    }

    if (message.type === "speaker" && message.label) {
      const speakerLabel = this.normalizedSpeaker(message.label);
      this.activeSpeaker = speakerLabel;
      const endMs = message.audioProcessedMs ?? this.lastProcessedMs;
      const startMs = this.currentTurnStartMs;
      this.callbacks.onSpeaker?.({
        startMs,
        endMs: Math.max(startMs + 1, endMs),
        speaker: speakerLabel,
        confidence: 1.0,
      });
      return;
    }

    if (message.type === "transcript") {
      const rawText = (message.transcript ?? "").trim();
      if (!rawText) return;

      const text = this.toTraditional(rawText);
      const endMs = message.audioProcessedMs ?? this.lastProcessedMs;
      const startMs = this.pendingSegment ? this.pendingSegment.startMs : this.currentTurnStartMs;

      if (message.final) {
        this.emitFinal(startMs, endMs, text);
        this.pendingSegment = null;
        this.currentTurnStartMs = endMs;
      } else {
        // Interim update
        this.pendingSegment = { startMs, endMs, text };
        this.callbacks.onText?.({
          startMs,
          endMs: Math.max(startMs + 1, endMs),
          text,
          isFinal: false,
        });

        // Safety limit check for continuous interim speech without punctuation
        const maxMs = this.options.maxSegmentMs ?? 30_000;
        const maxChars = this.options.maxSegmentCharacters ?? 160;
        if (endMs - startMs >= maxMs || text.length >= maxChars) {
          this.emitFinal(startMs, endMs, text);
          this.pendingSegment = null;
          this.currentTurnStartMs = endMs;
        }
      }
      return;
    }

    if (message.type === "speechComplete" || message.type === "speechEnd") {
      this.flushPendingSegment();
      if (message.audioProcessedMs !== undefined) {
        this.currentTurnStartMs = message.audioProcessedMs;
      }
      return;
    }

    if (message.type === "error") {
      this.callbacks.onWarning(`Muse Voice: ${message.message || "未知錯誤"}`);
    }
  }

  private toTraditional(text: string): string {
    if (this.options.toTraditional === false) return text;
    try {
      return this.toTraditionalConverter(text);
    } catch {
      return text;
    }
  }

  private emitFinal(startMs: number, endMs: number, text: string): void {
    const punctuated = this.ensureTerminalPunctuation(text);
    this.callbacks.onText?.({
      startMs,
      endMs: Math.max(startMs + 1, endMs),
      text: punctuated,
      isFinal: true,
    });
  }

  private flushPendingSegment(): void {
    if (!this.pendingSegment) return;
    this.emitFinal(this.pendingSegment.startMs, this.pendingSegment.endMs, this.pendingSegment.text);
    this.pendingSegment = null;
  }

  private ensureTerminalPunctuation(text: string): string {
    const trimmed = text.trim();
    if (!trimmed || /[。！？!?；;，,、：:…]["'」』）》】]?$/u.test(trimmed)) return trimmed;
    if (/(嗎|呢|麼)$/u.test(trimmed)) return `${trimmed}？`;
    return `${trimmed}。`;
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
