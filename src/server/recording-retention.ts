import fs from "node:fs/promises";
import path from "node:path";
import type { TranscriptDatabase } from "./database.js";

export async function deleteMeetingAudio(
  database: TranscriptDatabase,
  dataDir: string,
  meetingId: string,
): Promise<boolean> {
  const audioDirectory = getAudioDirectory(dataDir, meetingId);
  const marked = database.markAudioDeleted(meetingId);
  if (!marked?.recording.audioDeletedAt) return false;
  try {
    await fs.rm(audioDirectory, { recursive: true, force: true });
    return true;
  } catch (error) {
    database.restoreAudioDeletion(meetingId, marked.recording.audioDeletedAt);
    throw error;
  }
}

export async function cleanupExpiredRecordings(
  database: TranscriptDatabase,
  dataDir: string,
  retentionDays: number,
  now = new Date(),
): Promise<string[]> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
  const removed: string[] = [];
  for (const meeting of database.listExpiredRecordingMeetings(cutoff)) {
    if (await deleteMeetingAudio(database, dataDir, meeting.id)) removed.push(meeting.id);
  }
  return removed;
}

export async function deleteMeetingData(dataDir: string, meetingId: string): Promise<void> {
  const meetingDirectory = getMeetingDirectory(dataDir, meetingId);
  await fs.rm(meetingDirectory, { recursive: true, force: true });
}

function getAudioDirectory(dataDir: string, meetingId: string): string {
  return path.join(getMeetingDirectory(dataDir, meetingId), "audio");
}

function getMeetingDirectory(dataDir: string, meetingId: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(meetingId)) throw new Error("無效的會議 ID");
  const root = path.resolve(dataDir, "meetings");
  const meetingDirectory = path.resolve(root, meetingId);
  if (path.relative(root, meetingDirectory).startsWith("..") || path.isAbsolute(path.relative(root, meetingDirectory))) {
    throw new Error("會議資料夾不在允許範圍內");
  }
  return meetingDirectory;
}
