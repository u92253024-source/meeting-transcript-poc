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

/** 16 kHz mono 16-bit PCM. */
const BYTES_PER_MS = 32;
/** Audio kept while the socket is down, just enough to bridge a quick reconnect. */
const MAX_BRIDGE_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = 8;

interface QueuedAudio {
  audio: Buffer;
  startMs: number;
}

interface PendingSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export class MuseVoiceProvider implements AudioProvider {
  readonly name = "muse-voice-transcribe";
  private socket: WebSocket | null = null;
  private queued: QueuedAudio[] = [];
  private queuedBytes = 0;
  private readonly speakerMap = new Map<string, string>();
  private handshakeCompleted = false;
  private currentTurnStartMs = 0;
  private activeSpeaker: string | null = null;
  private pendingSegment: PendingSegment | null = null;
  private committedTurnText = "";
  private lastProcessedMs = 0;
  private sessionBaseMs = 0;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private readonly toTraditionalConverter = OpenCC.Converter({ from: "cn", to: "tw" });

  constructor(
    private readonly options: MuseVoiceOptions,
    private readonly callbacks: ProviderCallbacks,
  ) {}

  async start(): Promise<void> {
    if (!this.options.apiKey) throw new Error("MUSE_VOICE_API_KEY is not configured");
    await this.openSocket();
  }

  private openSocket(): Promise<void> {
    const endpoint = this.options.realtimeUrl || "wss://api.meta.ai/v1/asr/realtime";
    const socket = new WebSocket(endpoint);
    this.socket = socket;
    this.handshakeCompleted = false;

    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("error", (error) => this.callbacks.onWarning(`Muse Voice: ${error.message}`));
    socket.on("close", (code, reason) => this.handleClose(socket, code, reason.toString()));

    return new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
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
        socket.send(JSON.stringify(handshake));
        resolve();
      });
      socket.once("error", reject);
    });
  }

  /**
   * A dropped session used to go unnoticed: audio kept piling into the queue while the
   * transcript simply stopped. Report it, then rebuild the session and carry on.
   */
  private handleClose(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.socket) return;
    this.socket = null;
    this.handshakeCompleted = false;
    if (this.stopped) return;
    // Keep whatever this turn had already produced, then anchor the next turn to the
    // point the recording reached rather than to a start from before the outage.
    this.flushPendingSegment();
    this.startTurn(this.lastProcessedMs);
    const detail = reason ? `${code} ${reason}` : String(code);
    this.callbacks.onWarning(`Muse Voice 連線中斷（${detail}），正在重新連線…`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      this.callbacks.onWarning("Muse Voice 無法重新連線，即時逐字稿已停止；錄音仍在繼續，可於會後重新轉錄。");
      return;
    }
    const delayMs = Math.min(30_000, 1_000 * 2 ** (this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.openSocket().catch((error: Error) => {
        this.callbacks.onWarning(`Muse Voice 重新連線失敗：${error.message}`);
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref();
  }

  send(audio: Buffer, audioPositionMs: number): void {
    this.lastProcessedMs = Math.max(this.lastProcessedMs, audioPositionMs);
    if (this.stopped) return;
    if (this.socket?.readyState === WebSocket.OPEN && this.handshakeCompleted) {
      this.socket.send(audio);
      return;
    }
    // Hold only a short bridge while the socket is down. Replaying minutes of backlog
    // into a fresh session would transcribe stale speech over the live meeting.
    this.queued.push({ audio: Buffer.from(audio), startMs: audioPositionMs - audio.length / BYTES_PER_MS });
    this.queuedBytes += audio.length;
    while (this.queuedBytes > MAX_BRIDGE_MS * BYTES_PER_MS) {
      const dropped = this.queued.shift();
      if (!dropped) break;
      this.queuedBytes -= dropped.audio.length;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket) {
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
    }
    this.flushPendingSegment();
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
      this.reconnectAttempts = 0;
      // Every session numbers its audio from zero, so anchor it to the meeting clock.
      this.sessionBaseMs = this.queued[0]?.startMs ?? this.lastProcessedMs;
      if (this.socket?.readyState === WebSocket.OPEN) {
        for (const chunk of this.queued) this.socket.send(chunk.audio);
      }
      this.queued = [];
      this.queuedBytes = 0;
      return;
    }

    if (message.type === "speechStart") {
      this.startTurn(this.meetingMs(message.audioProcessedMs));
      return;
    }

    if (message.type === "speaker" && message.label) {
      const speakerLabel = this.normalizedSpeaker(message.label);
      this.activeSpeaker = speakerLabel;
      const endMs = this.meetingMs(message.audioProcessedMs);
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

      // The handshake asks for CUMULATIVE partials, so every message repeats the
      // whole turn. Drop what a mid-turn flush already stored, otherwise each later
      // message re-sends text that is on screen as a finished segment.
      const text = this.uncommittedText(this.toTraditional(rawText));
      const endMs = this.meetingMs(message.audioProcessedMs);
      const startMs = this.pendingSegment ? this.pendingSegment.startMs : this.currentTurnStartMs;

      if (message.final) {
        this.emitFinal(startMs, endMs, text);
        this.startTurn(endMs);
      } else if (text) {
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
      this.startTurn(
        message.audioProcessedMs === undefined ? this.currentTurnStartMs : this.meetingMs(message.audioProcessedMs),
      );
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
    if (!punctuated) return;
    this.committedTurnText += text;
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

  /** Converts a session-relative position into a position on the meeting clock. */
  private meetingMs(audioProcessedMs: number | undefined): number {
    return audioProcessedMs === undefined ? this.lastProcessedMs : this.sessionBaseMs + audioProcessedMs;
  }

  private startTurn(startMs: number): void {
    this.pendingSegment = null;
    this.committedTurnText = "";
    this.currentTurnStartMs = startMs;
  }

  /** Returns the part of a cumulative transcript not yet emitted as a final segment. */
  private uncommittedText(text: string): string {
    const committed = this.committedTurnText;
    if (!committed) return text;
    if (text.startsWith(committed)) return text.slice(committed.length);
    // The model revised wording it had already sent. Trust the shared prefix only
    // while it still covers most of the committed text; a weaker match means this is
    // not a continuation and skipping any of it would drop speech.
    let shared = 0;
    while (shared < committed.length && shared < text.length && committed[shared] === text[shared]) shared += 1;
    return shared * 2 >= committed.length ? text.slice(shared) : text;
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
