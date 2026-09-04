export const desktopTranscriptionModes = [
  "mock",
  "cloud",
  "cloud-stt-only",
  "deepgram",
  "deepgram-assembly",
  "muse-voice",
  "muse-voice-assembly",
] as const;

export type DesktopTranscriptionMode = typeof desktopTranscriptionModes[number];

export interface DesktopSettingsSummary {
  isDesktop: boolean;
  encryptionAvailable: boolean;
  transcriptionMode: DesktopTranscriptionMode;
  googleCloudProject: string;
  deepgramConfigured: boolean;
  museVoiceConfigured: boolean;
  assemblyAiConfigured: boolean;
  geminiConfigured: boolean;
}

export interface DesktopSettingsInput {
  adminPassword: string;
  transcriptionMode: DesktopTranscriptionMode;
  googleCloudProject: string;
  deepgramApiKey?: string;
  museVoiceApiKey?: string;
  assemblyAiApiKey?: string;
  geminiApiKey?: string;
  clearDeepgramApiKey?: boolean;
  clearMuseVoiceApiKey?: boolean;
  clearAssemblyAiApiKey?: boolean;
  clearGeminiApiKey?: boolean;
}
