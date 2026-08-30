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
  private queued: Buffer[] = [];
  private readonly speakerMap = new Map<number, string>();
  private pendingFinal: FinalRun | null = null;

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
      utterance_end_ms: String(this.options.utteranceEndMs),
      vad_events: "true",
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
    this.flushPending("stream_end");
    this.socket = null;
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
    const fallbackStart = Math.round((message.start ?? 0) * 1000);
    const fallbackEnd = fallbackStart + Math.round((message.duration ?? 0) * 1000);
    const wordStarts = words.flatMap((word) => typeof word.start === "number" ? [word.start] : []);
    const wordEnds = words.flatMap((word) => typeof word.end === "number" ? [word.end] : []);
    const startMs = wordStarts.length ? Math.round(Math.min(...wordStarts) * 1000) : fallbackStart;
    const endMs = wordEnds.length ? Math.round(Math.max(...wordEnds) * 1000) : fallbackEnd;
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
        startMs: Math.round(word.start * 1000),
        endMs: Math.round(word.end * 1000),
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
