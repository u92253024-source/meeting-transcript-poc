export type MeetingStatus = "recording" | "stopped";
export type PostprocessStatus = "not_requested" | "queued" | "processing" | "completed" | "failed";

export interface PostprocessInfo {
  status: PostprocessStatus;
  audioDurationMs: number;
  estimatedCostUsd: number;
  requestedAt: string | null;
  completedAt: string | null;
  error: string | null;
  transcriptId: string | null;
}

export type ReadableJobStatus = "not_requested" | "processing" | "completed" | "failed";
export type ReadableReviewStatus = "draft" | "accepted" | "rejected";

export interface ReadableInfo {
  status: ReadableJobStatus;
  characterCount: number;
  model: string;
  requestedAt: string | null;
  completedAt: string | null;
  error: string | null;
}

export interface ReadableVariant {
  id: string;
  meetingId: string;
  segmentId: string;
  version: number;
  sourceTextHash: string;
  text: string;
  status: ReadableReviewStatus;
  model: string;
  createdAt: string;
  reviewedAt: string | null;
  isStale: boolean;
}

export interface RecordingInfo {
  audioDeletedAt: string | null;
}

export interface Meeting {
  id: string;
  title: string;
  status: MeetingStatus;
  startedAt: string;
  stoppedAt: string | null;
  postprocess: PostprocessInfo;
  readable: ReadableInfo;
  recording: RecordingInfo;
}

export interface MeetingSummary extends Meeting {
  viewerCode: string;
  segmentCount: number;
  speakerCount: number;
}

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  startMs: number;
  endMs: number;
  text: string;
  speakerId: string;
  speaker: string;
  speakerConfidence: number | null;
  createdAt: string;
}

export interface MeetingSpeaker {
  id: string;
  meetingId: string;
  sourceLabel: string;
  displayName: string;
  isCustomName: boolean;
  createdAt: string;
}

export interface InterimTranscript {
  startMs: number;
  endMs: number;
  text: string;
  speaker: string;
}

export type ServerEvent =
  | { type: "ready"; meeting: Meeting; segments: TranscriptSegment[]; speakers: MeetingSpeaker[]; readableVariants: ReadableVariant[] }
  | { type: "interim"; transcript: InterimTranscript }
  | { type: "segment"; segment: TranscriptSegment }
  | { type: "segment_updated"; segment: TranscriptSegment }
  | { type: "audio_chunk"; filename: string; startMs: number; endMs: number }
  | { type: "status"; status: MeetingStatus }
  | { type: "meeting_updated"; meeting: Meeting }
  | { type: "speakers_updated"; speakers: MeetingSpeaker[] }
  | { type: "readable_variants_updated"; variants: ReadableVariant[] }
  | { type: "warning"; message: string };

export interface ProviderStatus {
  mode: "mock" | "cloud" | "cloud-stt-only" | "deepgram" | "deepgram-assembly" | "muse-voice" | "muse-voice-assembly";
  cloudSttConfigured: boolean;
  assemblyAiConfigured: boolean;
  deepgramConfigured: boolean;
  museVoiceConfigured: boolean;
  geminiConfigured: boolean;
  readableModel: string;
  adminPasswordConfigured: boolean;
  recordingRetentionDays: number;
  lanUrl: string | null;
}
