import speech from "@google-cloud/speech";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import type { AudioProvider, ProviderCallbacks } from "./types.js";

interface CloudSttOptions {
  project: string;
  location: string;
  recognizer: string;
  language: string;
  model: string;
}

interface DurationLike {
  seconds?: number | string | { toNumber(): number };
  nanos?: number;
}

interface StreamingResultLike {
  alternatives?: Array<{ transcript?: string }>;
  isFinal?: boolean;
  resultEndOffset?: DurationLike;
}

interface StreamingResponseLike {
  results?: StreamingResultLike[];
}

export class CloudSttProvider implements AudioProvider {
  readonly name = "google-cloud-stt-v2";
  private readonly client: speech.v2.SpeechClient;
  private stream: Duplex | null = null;
  private readonly streams = new Set<Duplex>();
  private streamBaseMs = 0;
  private lastFinalEndMs = 0;
  private failed = false;

  constructor(
    private readonly options: CloudSttOptions,
    private readonly callbacks: ProviderCallbacks,
  ) {
    this.client = new speech.v2.SpeechClient({
      projectId: options.project,
      apiEndpoint: `${options.location}-speech.googleapis.com`,
    });
  }

  async start(): Promise<void> {
    if (!this.options.project) throw new Error("GOOGLE_CLOUD_PROJECT 尚未設定");
    this.openStream(0);
  }

  send(audio: Buffer, audioPositionMs: number): void {
    if (this.failed) return;
    if (audioPositionMs - this.streamBaseMs >= 285_000) this.openStream(audioPositionMs);
    for (let offset = 0; offset < audio.length; offset += 25_600) {
      this.stream?.write({ audio: audio.subarray(offset, offset + 25_600) });
    }
  }

  async stop(): Promise<void> {
    const openStreams = [...this.streams];
    await Promise.all(openStreams.map((stream) => new Promise<void>((resolve) => {
      stream.once("close", resolve);
      stream.end();
      setTimeout(() => {
        if (!stream.destroyed) stream.destroy();
        resolve();
      }, 2_000).unref();
    })));
    this.stream = null;
    this.streams.clear();
    await Promise.race([this.client.close(), delay(3_000)]);
  }

  private openStream(baseMs: number): void {
    const previous = this.stream;
    const recognizer = `projects/${this.options.project}/locations/${this.options.location}/recognizers/${this.options.recognizer}`;
    const client = this.client as unknown as {
      _streamingRecognize(): Duplex;
    };
    this.stream = client._streamingRecognize();
    this.failed = false;
    this.streamBaseMs = baseMs;
    const current = this.stream;
    this.streams.add(current);
    current.on("data", (response: StreamingResponseLike) => this.handleResponse(response, baseMs));
    current.on("error", (error: Error) => {
      this.failed = true;
      this.callbacks.onWarning(`Cloud STT：${error.message}`);
    });
    current.on("close", () => this.streams.delete(current));
    current.write({
      recognizer,
      streamingConfig: {
        config: {
          explicitDecodingConfig: {
            encoding: "LINEAR16",
            sampleRateHertz: 16_000,
            audioChannelCount: 1,
          },
          languageCodes: [this.options.language],
          model: this.options.model,
          features: { enableAutomaticPunctuation: true },
        },
        streamingFeatures: { interimResults: true },
      },
    });
    previous?.end();
  }

  private handleResponse(response: StreamingResponseLike, baseMs: number): void {
    for (const result of response.results ?? []) {
      const text = result.alternatives?.[0]?.transcript?.trim();
      if (!text) continue;
      const endMs = baseMs + this.durationToMs(result.resultEndOffset);
      this.callbacks.onText?.({
        startMs: this.lastFinalEndMs,
        endMs: Math.max(endMs, this.lastFinalEndMs),
        text,
        isFinal: Boolean(result.isFinal),
      });
      if (result.isFinal) this.lastFinalEndMs = Math.max(endMs, this.lastFinalEndMs);
    }
  }

  private durationToMs(duration?: DurationLike): number {
    if (!duration) return this.lastFinalEndMs;
    const rawSeconds = duration.seconds;
    const seconds = typeof rawSeconds === "object"
      ? rawSeconds.toNumber()
      : Number(rawSeconds ?? 0);
    return Math.round(seconds * 1000 + (duration.nanos ?? 0) / 1_000_000);
  }
}
