import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { TranscriptDatabase } from "../src/server/database.js";
import { estimateAssemblyCostUsd } from "../src/server/postprocess/cost.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("post-meeting paid processing gate", () => {
  it("estimates Universal-3.5 Pro plus diarization by recorded duration", () => {
    expect(estimateAssemblyCostUsd(3_600_000, 0.21, 0.02)).toBe(0.23);
    expect(estimateAssemblyCostUsd(5 * 60_000, 0.21, 0.02)).toBeCloseTo(0.019167, 6);
  });

  it("allows one queued upload and rejects duplicate submissions", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-db-"));
    temporaryDirectories.push(directory);
    const database = new TranscriptDatabase(directory);
    const meeting = database.createMeeting("費用閘門測試");
    const stopped = database.stopMeeting(meeting.id, 3_600_000, 0.23)!;

    expect(stopped.postprocess).toMatchObject({
      status: "not_requested",
      audioDurationMs: 3_600_000,
      estimatedCostUsd: 0.23,
    });
    expect(database.queuePostprocess(meeting.id)?.postprocess.status).toBe("queued");
    expect(database.queuePostprocess(meeting.id)).toBeNull();
    database.close();
  });

  it("keeps the original stop time when stop is requested more than once", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-db-"));
    temporaryDirectories.push(directory);
    const database = new TranscriptDatabase(directory);
    const meeting = database.createMeeting("重複停止");
    const firstStop = database.stopMeeting(meeting.id, 1_000, 0)!;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const secondStop = database.stopMeeting(meeting.id, 9_999, 9)!;

    expect(secondStop.stoppedAt).toBe(firstStop.stoppedAt);
    expect(secondStop.postprocess.audioDurationMs).toBe(1_000);
    expect(secondStop.postprocess.estimatedCostUsd).toBe(0);
    database.close();
  });

  it("does not queue paid processing after audio deletion", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-db-"));
    temporaryDirectories.push(directory);
    const database = new TranscriptDatabase(directory);
    const meeting = database.createMeeting("已刪除錄音");
    database.stopMeeting(meeting.id, 3_600_000, 0.23);

    expect(database.markAudioDeleted(meeting.id)?.recording.audioDeletedAt).toBeTruthy();
    expect(database.queuePostprocess(meeting.id)).toBeNull();
    database.close();
  });

  it("recovers interrupted background jobs into retryable failures", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-db-"));
    temporaryDirectories.push(directory);
    const database = new TranscriptDatabase(directory);
    const meeting = database.createMeeting("中斷工作");
    const segment = database.addSegment({ meetingId: meeting.id, startMs: 0, endMs: 1_000, text: "測試", speaker: "講者 1", speakerConfidence: null });
    database.stopMeeting(meeting.id, 1_000, 0);
    database.queuePostprocess(meeting.id);
    database.markPostprocessProcessing(meeting.id);
    database.beginReadableGeneration(meeting.id, segment.text.length, "gemini-3.5-flash-lite");

    expect(database.recoverInterruptedWork()).toBe(2);
    expect(database.getMeeting(meeting.id)).toMatchObject({
      postprocess: { status: "failed" },
      readable: { status: "failed" },
    });
    database.close();
  });

  it("saves text corrections and renames a speaker across the meeting", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-db-"));
    temporaryDirectories.push(directory);
    const database = new TranscriptDatabase(directory);
    const meeting = database.createMeeting("校訂測試");
    const first = database.addSegment({ meetingId: meeting.id, startMs: 0, endMs: 1_000, text: "原文一", speaker: "講者 1", speakerConfidence: null });
    const second = database.addSegment({ meetingId: meeting.id, startMs: 1_000, endMs: 2_000, text: "原文二", speaker: "講者 1", speakerConfidence: null });
    database.stopMeeting(meeting.id, 2_000, 0.000128);

    expect(database.updateSegmentText(meeting.id, first.id, "修正文")?.text).toBe("修正文");
    const renamed = database.renameSpeaker(meeting.id, first.speakerId, "王主任")!;
    expect(renamed.segments).toHaveLength(2);
    expect(renamed.segments.every((segment) => segment.speaker === "王主任")).toBe(true);

    const postprocessed = database.updateSegmentSpeaker(first.id, "講者 1", 0.95)!;
    expect(postprocessed.speakerId).toBe(first.speakerId);
    expect(postprocessed.speaker).toBe("王主任");

    const added = database.createSpeaker(meeting.id, "李老師");
    expect(database.assignSegmentSpeaker(meeting.id, second.id, added.id)?.speaker).toBe("李老師");
    expect(database.mergeSpeakers(meeting.id, added.id, first.speakerId)).not.toBeNull();
    expect(database.listSegments(meeting.id).every((segment) => segment.speaker === "王主任")).toBe(true);
    database.close();
  });

  it("migrates legacy speaker strings into stable speaker profiles", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-db-"));
    temporaryDirectories.push(directory);
    const legacy = new DatabaseSync(path.join(directory, "transcripts.sqlite"));
    legacy.exec(`
      CREATE TABLE meetings (id TEXT PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL, stopped_at TEXT);
      CREATE TABLE transcript_segments (
        id TEXT PRIMARY KEY, meeting_id TEXT NOT NULL, start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL,
        text TEXT NOT NULL, speaker TEXT NOT NULL, speaker_confidence REAL, created_at TEXT NOT NULL
      );
      INSERT INTO meetings VALUES ('m1', '舊會議', 'stopped', '2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z');
      INSERT INTO transcript_segments VALUES ('s1', 'm1', 0, 1000, '舊內容', '王主任', NULL, '2026-01-01T00:00:01.000Z');
    `);
    legacy.close();

    const database = new TranscriptDatabase(directory);
    const [segment] = database.listSegments("m1");
    const [speaker] = database.listSpeakers("m1");
    expect(segment.speakerId).toBe(speaker.id);
    expect(speaker).toMatchObject({ displayName: "王主任", sourceLabel: "王主任", isCustomName: true });
    database.close();
  });

  it("keeps readable candidates separate and invalidates them after source edits", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-db-"));
    temporaryDirectories.push(directory);
    const database = new TranscriptDatabase(directory);
    const meeting = database.createMeeting("雙軌測試");
    const segment = database.addSegment({ meetingId: meeting.id, startMs: 0, endMs: 1_000, text: "嗯，今天開會。", speaker: "講者 1", speakerConfidence: null });
    database.stopMeeting(meeting.id, 1_000, 0);
    expect(database.beginReadableGeneration(meeting.id, segment.text.length, "gemini-3.5-flash-lite")?.readable.status).toBe("processing");
    const [variant] = database.saveReadableVariants(meeting.id, "gemini-3.5-flash-lite", [{ segmentId: segment.id, sourceText: segment.text, text: "今天開會。" }]);
    expect(database.reviewReadableVariant(meeting.id, variant.id, "accepted")?.status).toBe("accepted");
    expect(database.listReadableSegments(meeting.id)[0].text).toBe("今天開會。");

    database.updateSegmentText(meeting.id, segment.id, "今天召開會議。");
    expect(database.listReadableVariants(meeting.id)[0].isStale).toBe(true);
    expect(database.listReadableSegments(meeting.id)[0].text).toBe("今天召開會議。");
    database.close();
  });

  it("rejects review requests for superseded readable variants without changing the latest", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-db-"));
    temporaryDirectories.push(directory);
    const database = new TranscriptDatabase(directory);
    const meeting = database.createMeeting("候選版本測試");
    const segment = database.addSegment({ meetingId: meeting.id, startMs: 0, endMs: 1_000, text: "嗯，原文。", speaker: "講者 1", speakerConfidence: null });
    database.stopMeeting(meeting.id, 1_000, 0);
    const [oldVariant] = database.saveReadableVariants(meeting.id, "gemini-3.5-flash-lite", [
      { segmentId: segment.id, sourceText: segment.text, text: "舊候選。" },
    ]);
    const [latestVariant] = database.saveReadableVariants(meeting.id, "gemini-3.5-flash-lite", [
      { segmentId: segment.id, sourceText: segment.text, text: "新候選。" },
    ]);

    expect(database.reviewReadableVariant(meeting.id, oldVariant.id, "accepted")).toBeNull();
    expect(database.reviewReadableVariant(meeting.id, latestVariant.id, "accepted")?.status).toBe("accepted");
    expect(database.listReadableSegments(meeting.id)[0].text).toBe("新候選。");
    database.close();
  });
});
