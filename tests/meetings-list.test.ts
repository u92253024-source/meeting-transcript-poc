import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { TranscriptDatabase } from "../src/server/database.js";

describe("TranscriptDatabase listMeetings", () => {
  let tempDir = "";
  let db: TranscriptDatabase | null = null;

  afterEach(() => {
    if (db) {
      db.close();
      db = null;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Ignore temporary directory lock if any
      }
    }
  });

  it("returns meetings ordered by startedAt DESC with segment and speaker counts", () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nccu-meeting-test-"));
    db = new TranscriptDatabase(tempDir);

    // Initial check
    expect(db.listMeetings()).toEqual([]);

    // Create meeting 1
    const m1 = db.createMeeting("第 1 次教務會議", "CODE1111");
    // Create meeting 2
    const m2 = db.createMeeting("第 2 次教務會議", "CODE2222");

    // Add segments with speaker label "主席"
    db.addSegment({
      meetingId: m1.id,
      startMs: 0,
      endMs: 3000,
      text: "各位同仁好",
      speaker: "主席",
      speakerConfidence: 1.0,
    });
    db.addSegment({
      meetingId: m1.id,
      startMs: 3500,
      endMs: 7000,
      text: "現在開會",
      speaker: "主席",
      speakerConfidence: 1.0,
    });

    const list = db.listMeetings();
    expect(list).toHaveLength(2);

    // m2 was created after m1, so m2 should be first in startedAt DESC
    expect(list[0].id).toBe(m2.id);
    expect(list[0].viewerCode).toBe("CODE2222");
    expect(list[0].segmentCount).toBe(0);
    expect(list[0].speakerCount).toBe(0);

    // m1 should be second
    expect(list[1].id).toBe(m1.id);
    expect(list[1].viewerCode).toBe("CODE1111");
    expect(list[1].segmentCount).toBe(2);
    expect(list[1].speakerCount).toBe(1);
  });
});
