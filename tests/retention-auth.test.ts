import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AdminAuth } from "../src/server/admin-auth.js";
import { TranscriptDatabase } from "../src/server/database.js";
import { cleanupExpiredRecordings } from "../src/server/recording-retention.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("recording lifecycle and local administration", () => {
  it("stores only a password hash and verifies the configured password", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-auth-"));
    temporaryDirectories.push(directory);
    const database = new TranscriptDatabase(directory);
    const auth = new AdminAuth(database, "");

    expect(auth.isConfigured).toBe(false);
    auth.configure("安全測試密碼-2026");
    expect(auth.isConfigured).toBe(true);
    expect(auth.verify("安全測試密碼-2026")).toBe(true);
    expect(auth.verify("錯誤密碼")).toBe(false);
    expect(database.getSetting("admin_password_hash")).not.toContain("安全測試密碼-2026");
    database.close();
  });

  it("gives each meeting its own viewer code", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-code-"));
    temporaryDirectories.push(directory);
    const database = new TranscriptDatabase(directory);
    const first = database.createMeeting("第一場", "FIRST234");
    const second = database.createMeeting("第二場", "SECOND56");

    expect(database.hasValidViewerCode(first.id, "FIRST234")).toBe(true);
    expect(database.hasValidViewerCode(first.id, "SECOND56")).toBe(false);
    expect(database.hasValidViewerCode(second.id, "SECOND56")).toBe(true);
    database.close();
  });

  it("removes expired audio while preserving transcript data", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "meeting-retention-"));
    temporaryDirectories.push(directory);
    const database = new TranscriptDatabase(directory);
    const meeting = database.createMeeting("保存政策", "RETENTION");
    database.addSegment({ meetingId: meeting.id, startMs: 0, endMs: 1_000, text: "逐字稿應保留", speaker: "講者 1", speakerConfidence: null });
    database.stopMeeting(meeting.id, 1_000, 0);
    const audioDirectory = path.join(directory, "meetings", meeting.id, "audio");
    await fs.mkdir(audioDirectory, { recursive: true });
    await fs.writeFile(path.join(audioDirectory, "chunk-00001.wav"), "audio");

    const removed = await cleanupExpiredRecordings(database, directory, 0, new Date(Date.now() + 1_000));
    expect(removed).toEqual([meeting.id]);
    expect(await fs.stat(audioDirectory).then(() => true, () => false)).toBe(false);
    expect(database.getMeeting(meeting.id)?.recording.audioDeletedAt).toBeTruthy();
    expect(database.listSegments(meeting.id).map((segment) => segment.text)).toEqual(["逐字稿應保留"]);
    database.close();
  });
});
