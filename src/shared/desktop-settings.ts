export const desktopTranscriptionModes = ["mock", "cloud", "cloud-stt-only", "deepgram", "deepgram-assembly"] as const;

export type DesktopTranscriptionMode = typeof desktopTranscriptionModes[number];

export interface DesktopSettingsSummary {
  isDesktop: boolean;
  encryptionAvailable: boolean;
  transcriptionMode: DesktopTranscriptionMode;
  googleCloudProject: string;
  deepgramConfigured: boolean;
  assemblyAiConfigured: boolean;
  geminiConfigured: boolean;
}

export interface DesktopSettingsInput {
  adminPassword: string;
  transcriptionMode: DesktopTranscriptionMode;
  googleCloudProject: string;
  deepgramApiKey?: string;
  assemblyAiApiKey?: string;
  geminiApiKey?: string;
  clearDeepgramApiKey?: boolean;
  clearAssemblyAiApiKey?: boolean;
  clearGeminiApiKey?: boolean;
}
