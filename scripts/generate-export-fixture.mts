import fs from "node:fs/promises";
import path from "node:path";
import type { Meeting, TranscriptSegment } from "../src/shared/types.js";
import { generateTranscriptExport } from "../src/server/export/transcript-export.js";

const outputDirectory = path.resolve(process.argv[2] ?? path.join("tmp", "export-qa"));
await fs.rm(outputDirectory, { recursive: true, force: true });
await fs.mkdir(outputDirectory, { recursive: true });

const meeting: Meeting = {
  id: "00000000-0000-4000-8000-000000000099",
  title: "跨處室協作會議逐字稿 - 版面驗證樣本",
  status: "stopped",
  startedAt: "2026-08-09T01:30:00.000Z",
  stoppedAt: "2026-08-09T03:31:00.000Z",
  postprocess: { status: "completed", audioDurationMs: 7_260_000, estimatedCostUsd: 0.463833, requestedAt: null, completedAt: null, error: null, transcriptId: "fixture" },
  readable: { status: "completed", characterCount: 5_000, model: "gemini-3.5-flash-lite", requestedAt: null, completedAt: null, error: null },
};

const sampleTexts = [
  "今天的重點是確認跨處室協作流程、資料交付時間，以及每一項任務的負責窗口。請各單位在會後依照逐字稿與決議事項完成確認。",
  "目前的辨識結果會保留原始時間戳與講者身分，人工校訂只調整文字及顯示姓名，不會改變錄音位置，方便日後查核。",
  "若同一個字幕段落中出現短暫插話，系統仍可能把主要講者套用到整段，因此正式版需要保存單字層級時間戳，才能進行更細緻的拆分。",
  "請注意這是一段刻意加長的測試內容，用來確認繁體中文字在頁面右側會自然換行，不會超出邊界，也不會和下一位講者的標題或頁尾重疊。",
];
const names = ["王主任", "李老師", "陳組長", "林同學"];
const segments: TranscriptSegment[] = Array.from({ length: 44 }, (_, index) => ({
  id: `segment-${index + 1}`,
  meetingId: meeting.id,
  startMs: index * 165_000,
  endMs: index * 165_000 + 80_000,
  text: `${sampleTexts[index % sampleTexts.length]}（第 ${index + 1} 段）`,
  speakerId: `speaker-${index % names.length}`,
  speaker: names[index % names.length],
  speakerConfidence: 0.9,
  createdAt: meeting.startedAt,
}));

for (const format of ["txt", "md", "docx", "pdf"] as const) {
  await generateTranscriptExport({ meeting, segments }, format, outputDirectory);
}
console.log(outputDirectory);
