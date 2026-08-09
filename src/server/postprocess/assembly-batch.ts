import { createReadStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export interface AssemblyUtterance {
  start: number;
  end: number;
  speaker: string;
  confidence: number | null;
}

export interface AssemblyBatchResult {
  transcriptId: string;
  speechModelUsed: string | null;
  utterances: AssemblyUtterance[];
}

interface AssemblyBatchOptions {
  apiKey: string;
  model: string;
  audioPath: string;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  timeoutMs?: number;
}

export async function runAssemblyBatch(options: AssemblyBatchOptions): Promise<AssemblyBatchResult> {
  if (!options.apiKey) throw new Error("AssemblyAI API key 尚未設定");
  const fetchImpl = options.fetchImpl ?? fetch;
  const headers = { Authorization: options.apiKey };
  const uploadResponse = await fetchImpl("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { ...headers, "content-type": "application/octet-stream" },
    body: createReadStream(options.audioPath) as unknown as BodyInit,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
  if (!uploadResponse.ok) throw new Error(`AssemblyAI 上傳失敗 (${uploadResponse.status})：${await safeResponseText(uploadResponse)}`);
  const upload = await uploadResponse.json() as { upload_url?: string };
  if (!upload.upload_url) throw new Error("AssemblyAI 未回傳錄音網址");

  const submitResponse = await fetchImpl("https://api.assemblyai.com/v2/transcript", {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({
      audio_url: upload.upload_url,
      speech_models: [options.model],
      language_code: "zh",
      speaker_labels: true,
      format_text: true,
      punctuate: true,
    }),
  });
  if (!submitResponse.ok) throw new Error(`AssemblyAI 建立工作失敗 (${submitResponse.status})：${await safeResponseText(submitResponse)}`);
  const submitted = await submitResponse.json() as { id?: string };
  if (!submitted.id) throw new Error("AssemblyAI 未回傳逐字稿工作 ID");

  const deadline = Date.now() + (options.timeoutMs ?? 6 * 60 * 60_000);
  while (Date.now() < deadline) {
    const pollResponse = await fetchImpl(`https://api.assemblyai.com/v2/transcript/${submitted.id}`, { headers });
    if (!pollResponse.ok) throw new Error(`AssemblyAI 查詢工作失敗 (${pollResponse.status})：${await safeResponseText(pollResponse)}`);
    const transcript = await pollResponse.json() as {
      id?: string;
      status?: string;
      error?: string;
      speech_model_used?: string;
      utterances?: Array<{ start?: number; end?: number; speaker?: string; confidence?: number }>;
    };
    if (transcript.status === "completed") {
      return {
        transcriptId: transcript.id ?? submitted.id,
        speechModelUsed: transcript.speech_model_used ?? null,
        utterances: (transcript.utterances ?? [])
          .filter((utterance) => typeof utterance.start === "number" && typeof utterance.end === "number")
          .map((utterance) => ({
            start: utterance.start!,
            end: utterance.end!,
            speaker: utterance.speaker ?? "UNKNOWN",
            confidence: typeof utterance.confidence === "number" ? utterance.confidence : null,
          })),
      };
    }
    if (transcript.status === "error") throw new Error(`AssemblyAI 處理失敗：${transcript.error ?? "未知錯誤"}`);
    await delay(options.pollIntervalMs ?? 3_000);
  }
  throw new Error("AssemblyAI 會後處理逾時");
}

async function safeResponseText(response: Response): Promise<string> {
  return (await response.text()).slice(0, 500);
}
