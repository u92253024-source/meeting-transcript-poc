import type { SpeakerObservation } from "../alignment.js";

export interface TextObservation {
  startMs: number;
  endMs: number;
  text: string;
  isFinal: boolean;
}

export interface ProviderCallbacks {
  onText?: (observation: TextObservation) => void;
  onSpeaker?: (observation: SpeakerObservation) => void;
  onWarning: (message: string) => void;
}

export interface AudioProvider {
  readonly name: string;
  start(): Promise<void>;
  send(audio: Buffer, audioPositionMs: number): void;
  stop(): Promise<void>;
}
