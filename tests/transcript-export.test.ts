import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Meeting, TranscriptSegment } from "../src/shared/types.js";
import { buildMarkdown, buildPlainText, generateTranscriptExport } from "../src/server/export/transcript-export.js";

const temporaryDirectories: string[] = [];
const meeting: Meeting = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "中文測試會議",
  status: "stopped",
  startedAt: "2026-08-09T01:30:00.000Z",
  stoppedAt: "2026-08-09T01:32:00.000Z",
  postprocess: { status: "completed", audioDurationMs: 121_344, estimatedCostUsd: 0.007753, requestedAt: null, completedAt: null, error: null, transcriptId: "test" },
  readable: { status: "completed", characterCount: 30, model: "gemini-3.5-flash-lite", requestedAt: null, completedAt: null, error: null },
};
const segments: TranscriptSegment[] = [
  { id: "s1", meetingId: meeting.id, startMs: 0, endMs: 2_000, text: "大家好，今天討論會議逐字稿。", speakerId: "p1", speaker: "王主任", speakerConfidence: 0.95, createdAt: meeting.startedAt },
  { id: "s2", meetingId: meeting.id, startMs: 65_000, endMs: 70_000, text: "請確認時間戳與講者姓名。", speakerId: "p2", speaker: "李老師", speakerConfidence: 0.92, createdAt: meeting.startedAt },
];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("transcript exports", () => {
  it("uses one consistent transcript model for text and Markdown", () => {
    expect(buildPlainText({ meeting, segments })).toContain("[01:05] 李老師\r\n請確認時間戳與講者姓名。");
    expect(buildMarkdown({ meeting, segments })).toContain("**[01:05] 李老師**");
  });

  it("creates valid TXT, Markdown, DOCX, and PDF files", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-export-"));
    temporaryDirectories.push(directory);
    for (const format of ["txt", "md", "docx", "pdf"] as const) {
      const result = await generateTranscriptExport({ meeting, segments }, format, directory);
      const output = await fs.readFile(result.filePath);
      expect(output.length).toBeGreaterThan(100);
      if (format === "docx") expect(output.subarray(0, 2).toString("ascii")).toBe("PK");
      if (format === "pdf") expect(output.subarray(0, 4).toString("ascii")).toBe("%PDF");
    }
  });
});
