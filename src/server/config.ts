import dotenv from "dotenv";
import path from "node:path";
import { z } from "zod";

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH || path.resolve(process.cwd(), ".env") });

const schema = z.object({
  TRANSCRIPTION_MODE: z.enum(["mock", "cloud", "cloud-stt-only", "deepgram", "deepgram-assembly"]).default("mock"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3001),
  DATA_DIR: z.string().default("./data"),
  GOOGLE_CLOUD_PROJECT: z.string().default(""),
  GOOGLE_CLOUD_LOCATION: z.string().default("global"),
  GOOGLE_CLOUD_RECOGNIZER: z.string().default("_"),
  GOOGLE_STT_LANGUAGE: z.string().default("cmn-Hant-TW"),
  GOOGLE_STT_MODEL: z.string().default("chirp_3"),
  ASSEMBLYAI_API_KEY: z.string().default(""),
  ASSEMBLYAI_MAX_SPEAKERS: z.coerce.number().int().min(1).max(10).default(10),
  ASSEMBLYAI_STREAMING_MODEL: z.string().default("whisper-rt"),
  ASSEMBLYAI_BATCH_MODEL: z.string().default("universal-3-5-pro"),
  ASSEMBLYAI_BATCH_BASE_USD_PER_HOUR: z.coerce.number().nonnegative().default(0.21),
  ASSEMBLYAI_DIARIZATION_USD_PER_HOUR: z.coerce.number().nonnegative().default(0.02),
  DEEPGRAM_API_KEY: z.string().default(""),
  DEEPGRAM_MODEL: z.string().default("nova-3"),
  DEEPGRAM_LANGUAGE: z.string().default("zh-TW"),
  DEEPGRAM_KEYTERMS: z.string().default(""),
  GEMINI_API_KEY: z.string().default(""),
  GEMINI_READABLE_MODEL: z.string().default("gemini-3.5-flash-lite"),
  RECORDING_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  VIEW_ACCESS_CODE: z.string().default(""),
  ADMIN_PASSWORD: z.string().default(""),
});

const parsed = schema.parse(process.env);

export const config = {
  mode: parsed.TRANSCRIPTION_MODE,
  host: parsed.HOST,
  port: parsed.PORT,
  dataDir: path.resolve(process.cwd(), parsed.DATA_DIR),
  google: {
    project: parsed.GOOGLE_CLOUD_PROJECT,
    location: parsed.GOOGLE_CLOUD_LOCATION,
    recognizer: parsed.GOOGLE_CLOUD_RECOGNIZER,
    language: parsed.GOOGLE_STT_LANGUAGE,
    model: parsed.GOOGLE_STT_MODEL,
  },
  assembly: {
    apiKey: parsed.ASSEMBLYAI_API_KEY,
    maxSpeakers: parsed.ASSEMBLYAI_MAX_SPEAKERS,
    streamingModel: parsed.ASSEMBLYAI_STREAMING_MODEL,
    batchModel: parsed.ASSEMBLYAI_BATCH_MODEL,
    batchBaseUsdPerHour: parsed.ASSEMBLYAI_BATCH_BASE_USD_PER_HOUR,
    diarizationUsdPerHour: parsed.ASSEMBLYAI_DIARIZATION_USD_PER_HOUR,
  },
  deepgram: {
    apiKey: parsed.DEEPGRAM_API_KEY,
    model: parsed.DEEPGRAM_MODEL,
    language: parsed.DEEPGRAM_LANGUAGE,
    keyterms: parsed.DEEPGRAM_KEYTERMS.split(",").map((term) => term.trim()).filter(Boolean),
  },
  gemini: {
    apiKey: parsed.GEMINI_API_KEY,
    readableModel: parsed.GEMINI_READABLE_MODEL,
  },
  recordingRetentionDays: parsed.RECORDING_RETENTION_DAYS,
  legacyViewAccessCode: parsed.VIEW_ACCESS_CODE,
  bootstrapAdminPassword: parsed.ADMIN_PASSWORD,
};
