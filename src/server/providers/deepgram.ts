import WebSocket from "ws";
import type { AudioProvider, ProviderCallbacks } from "./types.js";

interface DeepgramOptions {
  apiKey: string;
  model: string;
  language: string;
  keyterms: string[];
  diarization?: boolean;
  utteranceEndMs: number;
  maxSegmentMs: number;
  maxSegmentCharacters: number;
}

interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
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

/** 16 kHz mono 16-bit PCM. */
const BYTES_PER_MS = 32;
/** Audio kept while the socket is down, just enough to bridge a quick reconnect. */
const MAX_BRIDGE_MS = 10_000;
const MAX_RECONNECT_ATTEMPTS = 8;

interface QueuedAudio {
  audio: Buffer;
  startMs: number;
}

interface FinalRun {
  startMs: number;
  endMs: number;
  text: string;
  speaker: number | null;
  boundaryBefore?: FlushReason;
}

type FlushReason = "speech_final" | "utterance_end" | "speaker_change" | "hard_limit" | "stream_end";

export class DeepgramProvider implements AudioProvider {
  readonly name = "deepgram-nova-3";
  private socket: WebSocket | null = null;
  private queued: QueuedAudio[] = [];
  private queuedBytes = 0;
  private readonly speakerMap = new Map<number, string>();
  private pendingFinal: FinalRun | null = null;
  private lastProcessedMs = 0;
  private sessionBaseMs = 0;
  private stopped = false;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly options: DeepgramOptions,
    private readonly callbacks: ProviderCallbacks,
  ) {}

  async start(): Promise<void> {
    if (!this.options.apiKey) throw new Error("DEEPGRAM_API_KEY is not configured");
    await this.openSocket();
  }

  private openSocket(): Promise<void> {
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
      utterance_end_ms: String(this.options.utteranceEndMs),
      vad_events: "true",
    });
    if (this.options.diarization !== false) query.set("diarize_model", "latest");
    for (const keyterm of this.options.keyterms) query.append("keyterm", keyterm);

    const socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, {
      headers: { Authorization: `Token ${this.options.apiKey}` },
    });
    this.socket = socket;
    socket.on("message", (data) => this.handleMessage(data.toString()));
    socket.on("error", (error) => this.callbacks.onWarning(`Deepgram: ${error.message}`));
    socket.on("close", (code, reason) => this.handleClose(socket, code, reason.toString()));
    return new Promise<void>((resolve, reject) => {
      socket.once("open", () => {
        // Each connection times its words from zero, so anchor it to the meeting clock.
        this.sessionBaseMs = this.queued[0]?.startMs ?? this.lastProcessedMs;
        this.reconnectAttempts = 0;
        for (const chunk of this.queued) socket.send(chunk.audio);
        this.queued = [];
        this.queuedBytes = 0;
        resolve();
      });
      socket.once("error", reject);
    });
  }

  /**
   * A dropped connection used to go unnoticed: audio kept piling into the queue while
   * the transcript simply stopped. Report it, then reconnect and carry on.
   */
  private handleClose(socket: WebSocket, code: number, reason: string): void {
    if (socket !== this.socket) return;
    this.socket = null;
    if (this.stopped) return;
    // Keep whatever was finalized before the line went down.
    this.flushPending("stream_end");
    const detail = reason ? `${code} ${reason}` : String(code);
    this.callbacks.onWarning(`Deepgram 連線中斷（${detail}），正在重新連線…`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      this.callbacks.onWarning("Deepgram 無法重新連線，即時逐字稿已停止；錄音仍在繼續，可於會後重新轉錄。");
      return;
    }
    const delayMs = Math.min(30_000, 1_000 * 2 ** (this.reconnectAttempts - 1));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      void this.openSocket().catch((error: Error) => {
        this.callbacks.onWarning(`Deepgram 重新連線失敗：${error.message}`);
        this.scheduleReconnect();
      });
    }, delayMs);
    this.reconnectTimer.unref();
  }

  send(audio: Buffer, audioPositionMs: number): void {
    this.lastProcessedMs = Math.max(this.lastProcessedMs, audioPositionMs);
    if (this.stopped) return;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(audio);
      return;
    }
    // Hold only a short bridge while the socket is down. Replaying minutes of backlog
    // into a fresh connection would transcribe stale speech over the live meeting.
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
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "CloseStream" }));
      await new Promise<void>((resolve) => {
        if (socket.readyState === WebSocket.CLOSED) return resolve();
        socket.once("close", resolve);
        setTimeout(() => {
          if (socket.readyState !== WebSocket.CLOSED) socket.close();
          resolve();
        }, 5_000).unref();
      });
    }
    this.flushPending("stream_end");
  }

  private handleMessage(raw: string): void {
    let message: DeepgramResults;
    try {
      message = JSON.parse(raw) as DeepgramResults;
    } catch {
      return;
    }
    if (message.type === "UtteranceEnd") {
      this.flushPending("utterance_end");
      return;
    }
    if (message.type !== "Results") return;
    const alternative = message.channel?.alternatives?.[0];
    const text = alternative?.transcript?.trim();
    if (!text) return;

    const words = alternative?.words ?? [];
    if (this.options.diarization !== false) this.emitSpeakerRuns(words);
    const fallbackStart = this.toMeetingMs(message.start ?? 0);
    const fallbackEnd = fallbackStart + Math.round((message.duration ?? 0) * 1000);
    const wordStarts = words.flatMap((word) => typeof word.start === "number" ? [word.start] : []);
    const wordEnds = words.flatMap((word) => typeof word.end === "number" ? [word.end] : []);
    const startMs = wordStarts.length ? this.toMeetingMs(Math.min(...wordStarts)) : fallbackStart;
    const endMs = wordEnds.length ? this.toMeetingMs(Math.max(...wordEnds)) : fallbackEnd;
    if (message.is_final) {
      const runs = this.createFinalRuns(text, words, startMs, endMs);
      for (const run of runs) this.appendFinal(run);
      if (message.speech_final || message.from_finalize) this.flushPending("speech_final");
      else if (this.pendingFinal) {
        this.emitInterim(this.pendingFinal.startMs, this.pendingFinal.endMs, this.pendingFinal.text);
      }
      return;
    }

    const interimText = this.pendingFinal ? this.joinTranscript(this.pendingFinal.text, text) : text;
    this.emitInterim(this.pendingFinal?.startMs ?? startMs, endMs, interimText);
  }

  /** Converts a session-relative offset in seconds into a position on the meeting clock. */
  private toMeetingMs(seconds: number): number {
    return this.sessionBaseMs + Math.round(seconds * 1000);
  }

  private emitInterim(startMs: number, endMs: number, text: string): void {
    this.callbacks.onText?.({ startMs, endMs: Math.max(startMs + 1, endMs), text, isFinal: false });
  }

  private appendFinal(run: FinalRun): void {
    const pending = this.pendingFinal;
    if (pending) {
      const speakerChanged = pending.speaker !== null && run.speaker !== null && pending.speaker !== run.speaker;
      const wordGapMs = run.startMs - pending.endMs;
      const exceedsDuration = Math.max(pending.endMs, run.endMs) - pending.startMs > this.options.maxSegmentMs;
      const exceedsCharacters = pending.text.length + run.text.length > this.options.maxSegmentCharacters;
      if (run.boundaryBefore) this.flushPending(run.boundaryBefore);
      else if (speakerChanged) this.flushPending("speaker_change");
      else if (wordGapMs >= this.options.utteranceEndMs) this.flushPending("utterance_end");
      else if (this.hasSentenceEndingPunctuation(pending.text)) this.flushPending("speech_final");
      else if (exceedsDuration || exceedsCharacters) this.flushPending("hard_limit");
    }

    if (!this.pendingFinal) {
      this.pendingFinal = { ...run };
    } else {
      this.pendingFinal.endMs = Math.max(this.pendingFinal.endMs, run.endMs);
      this.pendingFinal.text = this.joinTranscript(this.pendingFinal.text, run.text);
      this.pendingFinal.speaker ??= run.speaker;
    }

    if (
      this.pendingFinal.endMs - this.pendingFinal.startMs >= this.options.maxSegmentMs
      || this.pendingFinal.text.length >= this.options.maxSegmentCharacters
    ) {
      this.flushPending("hard_limit");
    }
  }

  private flushPending(reason: FlushReason): void {
    if (!this.pendingFinal) return;
    this.callbacks.onText?.({
      startMs: this.pendingFinal.startMs,
      endMs: Math.max(this.pendingFinal.startMs + 1, this.pendingFinal.endMs),
      text: this.ensureTerminalPunctuation(this.pendingFinal.text, reason),
      isFinal: true,
    });
    this.pendingFinal = null;
  }

  private joinTranscript(left: string, right: string): string {
    if (!left) return right;
    if (!right) return left;
    const leftWord = [...left].reverse().find((character) => /[\p{L}\p{N}]/u.test(character));
    const rightWord = [...right].find((character) => /[\p{L}\p{N}]/u.test(character));
    const rightStartsWithClosingPunctuation = /^[，。！？；：、,.!?;:%）】〉」』]/u.test(right);
    const needsSpace = Boolean(
      leftWord && rightWord
      && /[A-Za-z0-9]/.test(leftWord)
      && /[A-Za-z0-9]/.test(rightWord)
      && !rightStartsWithClosingPunctuation,
    );
    return `${left}${needsSpace ? " " : ""}${right}`;
  }

  private createFinalRuns(text: string, words: DeepgramWord[], fallbackStartMs: number, fallbackEndMs: number): FinalRun[] {
    const usableWords = words.flatMap((word) => {
      const token = (word.punctuated_word ?? word.word ?? "").trim();
      if (!token || typeof word.start !== "number" || typeof word.end !== "number") return [];
      return [{
        token,
        startMs: this.toMeetingMs(word.start),
        endMs: this.toMeetingMs(word.end),
        speaker: this.options.diarization === false || typeof word.speaker !== "number" ? null : word.speaker,
      }];
    });
    if (usableWords.length === 0 || usableWords.length !== words.length) {
      return this.createFallbackRuns(text, fallbackStartMs, fallbackEndMs);
    }

    const runs: FinalRun[] = [];
    for (const word of usableWords) {
      const current: FinalRun | undefined = runs.length > 0 ? runs[runs.length - 1] : undefined;
      const speaker: number | null = word.speaker ?? current?.speaker ?? null;
      const nextText = current ? this.joinTranscript(current.text, word.token) : word.token;
      const speakerChanged = current
        ? current.speaker !== null && speaker !== null && current.speaker !== speaker
        : false;
      const wordGapMs = current ? word.startMs - current.endMs : 0;
      const sentenceEnded = current ? this.hasSentenceEndingPunctuation(current.text) : false;
      const exceedsDuration = current ? word.endMs - current.startMs > this.options.maxSegmentMs : false;
      const exceedsCharacters = current ? nextText.length > this.options.maxSegmentCharacters : false;
      if (!current || speakerChanged || wordGapMs >= this.options.utteranceEndMs || sentenceEnded || exceedsDuration || exceedsCharacters) {
        const boundaryBefore: FlushReason | undefined = !current
          ? undefined
          : speakerChanged
            ? "speaker_change"
            : wordGapMs >= this.options.utteranceEndMs
              ? "utterance_end"
              : sentenceEnded
                ? "speech_final"
                : "hard_limit";
        runs.push({ startMs: word.startMs, endMs: word.endMs, text: word.token, speaker, boundaryBefore });
      } else {
        current.endMs = Math.max(current.endMs, word.endMs);
        current.text = nextText;
        current.speaker ??= speaker;
      }
    }

    if (runs.length === 1) runs[0].text = text;
    return runs;
  }

  private createFallbackRuns(text: string, startMs: number, endMs: number): FinalRun[] {
    const characters = [...text];
    const durationMs = Math.max(1, endMs - startMs);
    const maxCharactersByDuration = Math.max(
      1,
      Math.floor(characters.length * this.options.maxSegmentMs / durationMs),
    );
    const pieceLimit = Math.min(this.options.maxSegmentCharacters, maxCharactersByDuration);
    const pieces: Array<{ text: string; reasonAfter: FlushReason }> = [];
    let current = "";

    for (let index = 0; index < characters.length; index += 1) {
      current += characters[index];
      const sentenceEnded = /[。！？!?]/u.test(characters[index]);
      if (sentenceEnded) {
        while (index + 1 < characters.length && /["'」』）》】]/u.test(characters[index + 1])) {
          index += 1;
          current += characters[index];
        }
      }
      if (sentenceEnded || [...current].length >= pieceLimit) {
        pieces.push({ text: current, reasonAfter: sentenceEnded ? "speech_final" : "hard_limit" });
        current = "";
      }
    }
    if (current) pieces.push({ text: current, reasonAfter: "speech_final" });

    let consumedCharacters = 0;
    return pieces.map((piece, index) => {
      const pieceCharacters = [...piece.text].length;
      const pieceStartMs = startMs + Math.round(durationMs * consumedCharacters / characters.length);
      consumedCharacters += pieceCharacters;
      const pieceEndMs = index === pieces.length - 1
        ? endMs
        : startMs + Math.round(durationMs * consumedCharacters / characters.length);
      return {
        startMs: pieceStartMs,
        endMs: Math.max(pieceStartMs + 1, pieceEndMs),
        text: piece.text,
        speaker: null,
        boundaryBefore: index === 0 ? undefined : pieces[index - 1].reasonAfter,
      };
    });
  }

  private ensureTerminalPunctuation(text: string, reason: FlushReason): string {
    const trimmed = text.trim();
    if (!trimmed || /[。！？!?；;，,、：:…]["'」』）》】]?$/u.test(trimmed)) return trimmed;
    if (reason === "hard_limit") return `${trimmed}，`;
    if (/(嗎|呢|麼)$/u.test(trimmed)) return `${trimmed}？`;
    return `${trimmed}。`;
  }

  private hasSentenceEndingPunctuation(text: string): boolean {
    return /[。！？!?]["'」』）》】]?$/u.test(text.trim());
  }

  private emitSpeakerRuns(words: DeepgramWord[]): void {
    let run: { speaker: number; start: number; end: number; confidence: number | null } | null = null;
    const flush = () => {
      if (!run) return;
      this.callbacks.onSpeaker?.({
        startMs: this.toMeetingMs(run.start),
        endMs: Math.max(this.toMeetingMs(run.start) + 1, this.toMeetingMs(run.end)),
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
