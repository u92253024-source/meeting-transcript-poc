import path from "node:path";
import type { ServerEvent, TranscriptSegment } from "../shared/types.js";
import { SpeakerTimeline, type SpeakerObservation } from "./alignment.js";
import { WavChunkWriter } from "./audio/wav-chunk-writer.js";
import { config } from "./config.js";
import type { TranscriptDatabase } from "./database.js";
import { AssemblyStreamingProvider } from "./providers/assembly-streaming.js";
import { CloudSttProvider } from "./providers/cloud-stt.js";
import { DeepgramProvider } from "./providers/deepgram.js";
import { MockProvider } from "./providers/mock.js";
import { MuseVoiceProvider } from "./providers/muse-voice.js";
import type { AudioProvider, ProviderCallbacks, TextObservation } from "./providers/types.js";

export class MeetingSession {
  private readonly timeline = new SpeakerTimeline();
  private readonly writer: WavChunkWriter;
  private readonly providers: AudioProvider[];
  private audioQueue = Promise.resolve();
  private stopped = false;

  constructor(
    readonly meetingId: string,
    private readonly database: TranscriptDatabase,
    private readonly broadcast: (event: ServerEvent) => void,
  ) {
    const callbacks: ProviderCallbacks = {
      onText: (observation) => this.onText(observation),
      onSpeaker: (observation) => this.onSpeaker(observation),
      onWarning: (message) => this.broadcast({ type: "warning", message }),
    };
    this.writer = new WavChunkWriter(path.join(config.dataDir, "meetings", meetingId, "audio"), {
      onChunk: (chunk) => this.broadcast({ type: "audio_chunk", ...chunk }),
    });
    this.providers = this.createProviders(callbacks);
  }

  async start(): Promise<void> {
    const started: AudioProvider[] = [];
    for (const provider of this.providers) {
      try {
        await provider.start();
        started.push(provider);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.broadcast({ type: "warning", message: `${provider.name} 無法啟動：${message}` });
        await Promise.allSettled(started.map((activeProvider) => activeProvider.stop()));
        throw error;
      }
    }
  }

  ingestAudio(audio: Buffer): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const normalized = audio.length % 2 === 0 ? audio : audio.subarray(0, audio.length - 1);
    this.audioQueue = this.audioQueue.then(async () => {
      await this.writer.write(normalized);
      const position = this.writer.durationMs;
      for (const provider of this.providers) provider.send(normalized, position);
    });
    return this.audioQueue;
  }

  async stop(): Promise<number> {
    if (this.stopped) return this.writer.durationMs;
    this.stopped = true;
    await this.audioQueue;
    await Promise.allSettled(this.providers.map((provider) => provider.stop()));
    await this.writer.close();
    return this.writer.durationMs;
  }

  private createProviders(callbacks: ProviderCallbacks): AudioProvider[] {
    if (config.mode === "mock") return [new MockProvider(callbacks)];
    if (config.mode === "deepgram") return [new DeepgramProvider({ ...config.deepgram, diarization: true }, callbacks)];
    if (config.mode === "deepgram-assembly") {
      return [
        // Deepgram provides provisional live text and speaker labels. AssemblyAI
        // batch diarization replaces the labels after the recording is complete.
        new DeepgramProvider({ ...config.deepgram, diarization: true }, callbacks),
      ];
    }
    if (config.mode === "muse-voice" || config.mode === "muse-voice-assembly") {
      return [new MuseVoiceProvider(config.museVoice, callbacks)];
    }
    const providers: AudioProvider[] = [new CloudSttProvider(config.google, callbacks)];
    if (config.mode === "cloud") {
      providers.push(new AssemblyStreamingProvider(
        config.assembly.apiKey,
        config.assembly.maxSpeakers,
        config.assembly.streamingModel,
        callbacks,
      ));
    }
    return providers;
  }

  private onText(observation: TextObservation): void {
    const match = this.timeline.findForRange(observation.startMs, observation.endMs);
    const speaker = match?.speaker ?? "講者待確認";
    if (!observation.isFinal) {
      this.broadcast({ type: "interim", transcript: { ...observation, speaker } });
      return;
    }
    const segment = this.database.addSegment({
      meetingId: this.meetingId,
      startMs: observation.startMs,
      endMs: observation.endMs,
      text: observation.text,
      speaker,
      speakerConfidence: match?.confidence ?? null,
    });
    this.broadcast({ type: "segment", segment });
    this.broadcast({ type: "speakers_updated", speakers: this.database.listSpeakers(this.meetingId) });
  }

  private onSpeaker(observation: SpeakerObservation): void {
    this.timeline.add(observation);
    const recent = this.database.listSegments(this.meetingId).slice(-30);
    let changed = false;
    for (const segment of this.timeline.segmentsAffectedBy(observation, recent)) {
      if (segment.speaker === observation.speaker && segment.speakerConfidence === observation.confidence) continue;
      const updated = this.database.updateSegmentSpeaker(segment.id, observation.speaker, observation.confidence);
      if (updated) {
        changed = true;
        this.broadcast({ type: "segment_updated", segment: updated });
      }
    }
    if (changed) this.broadcast({ type: "speakers_updated", speakers: this.database.listSpeakers(this.meetingId) });
  }
}
