import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { Meeting, MeetingSpeaker, MeetingSummary, PostprocessStatus, ReadableReviewStatus, ReadableVariant, TranscriptSegment } from "../shared/types.js";

interface MeetingRow {
  id: string;
  title: string;
  status: Meeting["status"];
  started_at: string;
  stopped_at: string | null;
  audio_duration_ms: number;
  estimated_cost_usd: number;
  postprocess_status: PostprocessStatus;
  postprocess_requested_at: string | null;
  postprocess_completed_at: string | null;
  postprocess_error: string | null;
  assembly_transcript_id: string | null;
  readable_status: Meeting["readable"]["status"];
  readable_character_count: number;
  readable_model: string;
  readable_requested_at: string | null;
  readable_completed_at: string | null;
  readable_error: string | null;
  viewer_code: string;
  audio_deleted_at: string | null;
}

interface SegmentRow {
  id: string;
  meeting_id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  speaker_id: string;
  speaker: string;
  speaker_confidence: number | null;
  created_at: string;
}

interface SpeakerRow {
  id: string;
  meeting_id: string;
  source_label: string;
  display_name: string;
  is_custom_name: number;
  created_at: string;
}

interface ReadableVariantRow {
  id: string;
  meeting_id: string;
  segment_id: string;
  version: number;
  source_text_hash: string;
  text: string;
  status: ReadableReviewStatus;
  model: string;
  created_at: string;
  reviewed_at: string | null;
  current_text: string;
}

export class TranscriptDatabase {
  private readonly db: DatabaseSync;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(path.join(dataDir, "transcripts.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meetings (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        stopped_at TEXT,
        audio_duration_ms INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd REAL NOT NULL DEFAULT 0,
        postprocess_status TEXT NOT NULL DEFAULT 'not_requested',
        postprocess_requested_at TEXT,
        postprocess_completed_at TEXT,
        postprocess_error TEXT,
        assembly_transcript_id TEXT,
        readable_status TEXT NOT NULL DEFAULT 'not_requested',
        readable_character_count INTEGER NOT NULL DEFAULT 0,
        readable_model TEXT NOT NULL DEFAULT '',
        readable_requested_at TEXT,
        readable_completed_at TEXT,
        readable_error TEXT,
        viewer_code TEXT NOT NULL DEFAULT '',
        audio_deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS transcript_segments (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        start_ms INTEGER NOT NULL,
        end_ms INTEGER NOT NULL,
        text TEXT NOT NULL,
        speaker_id TEXT REFERENCES meeting_speakers(id),
        speaker TEXT NOT NULL,
        speaker_confidence REAL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_segments_meeting_time
        ON transcript_segments(meeting_id, start_ms);
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meeting_speakers (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        source_label TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_custom_name INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(meeting_id, source_label)
      );
      CREATE INDEX IF NOT EXISTS idx_speakers_meeting
        ON meeting_speakers(meeting_id, created_at);
      CREATE TABLE IF NOT EXISTS transcript_readable_variants (
        id TEXT PRIMARY KEY,
        meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
        segment_id TEXT NOT NULL REFERENCES transcript_segments(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        source_text_hash TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        model TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reviewed_at TEXT,
        UNIQUE(segment_id, version)
      );
      CREATE INDEX IF NOT EXISTS idx_readable_meeting_segment
        ON transcript_readable_variants(meeting_id, segment_id, version);
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.ensureMeetingColumn("audio_duration_ms", "INTEGER NOT NULL DEFAULT 0");
    this.ensureMeetingColumn("estimated_cost_usd", "REAL NOT NULL DEFAULT 0");
    this.ensureMeetingColumn("postprocess_status", "TEXT NOT NULL DEFAULT 'not_requested'");
    this.ensureMeetingColumn("postprocess_requested_at", "TEXT");
    this.ensureMeetingColumn("postprocess_completed_at", "TEXT");
    this.ensureMeetingColumn("postprocess_error", "TEXT");
    this.ensureMeetingColumn("assembly_transcript_id", "TEXT");
    this.ensureMeetingColumn("readable_status", "TEXT NOT NULL DEFAULT 'not_requested'");
    this.ensureMeetingColumn("readable_character_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureMeetingColumn("readable_model", "TEXT NOT NULL DEFAULT ''");
    this.ensureMeetingColumn("readable_requested_at", "TEXT");
    this.ensureMeetingColumn("readable_completed_at", "TEXT");
    this.ensureMeetingColumn("readable_error", "TEXT");
    this.ensureMeetingColumn("viewer_code", "TEXT NOT NULL DEFAULT ''");
    this.ensureMeetingColumn("audio_deleted_at", "TEXT");
    this.ensureSegmentColumn("speaker_id", "TEXT");
    this.backfillSpeakerProfiles();
  }

  createMeeting(title: string, viewerCode: string = crypto.randomUUID()): Meeting {
    const meeting: Meeting = {
      id: crypto.randomUUID(),
      title,
      status: "recording",
      startedAt: new Date().toISOString(),
      stoppedAt: null,
      postprocess: {
        status: "not_requested",
        audioDurationMs: 0,
        estimatedCostUsd: 0,
        requestedAt: null,
        completedAt: null,
        error: null,
        transcriptId: null,
      },
      readable: {
        status: "not_requested",
        characterCount: 0,
        model: "",
        requestedAt: null,
        completedAt: null,
        error: null,
      },
      recording: { audioDeletedAt: null },
    };
    this.db.prepare(
      "INSERT INTO meetings (id, title, status, started_at, stopped_at, viewer_code) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(meeting.id, meeting.title, meeting.status, meeting.startedAt, meeting.stoppedAt, viewerCode);
    return meeting;
  }

  hasValidViewerCode(id: string, code: string): boolean {
    if (!code) return false;
    const row = this.db.prepare("SELECT viewer_code FROM meetings WHERE id = ?").get(id) as { viewer_code: string } | undefined;
    return Boolean(row && row.viewer_code && row.viewer_code === code);
  }

  backfillLegacyViewerCodes(legacyCode: string): void {
    if (!legacyCode) return;
    this.db.prepare("UPDATE meetings SET viewer_code = ? WHERE viewer_code IS NULL OR viewer_code = ''").run(legacyCode);
  }

  listExpiredRecordingMeetings(cutoff: string): Meeting[] {
    const rows = this.db.prepare(`
      SELECT * FROM meetings
      WHERE status = 'stopped' AND stopped_at IS NOT NULL AND stopped_at <= ?
        AND audio_deleted_at IS NULL AND postprocess_status NOT IN ('queued', 'processing')
    `).all(cutoff) as unknown as MeetingRow[];
    return rows.map((row) => this.mapMeeting(row));
  }

  markAudioDeleted(id: string): Meeting | null {
    const result = this.db.prepare(`
      UPDATE meetings SET audio_deleted_at = ?
      WHERE id = ? AND status = 'stopped' AND audio_deleted_at IS NULL
        AND postprocess_status NOT IN ('queued', 'processing')
    `).run(new Date().toISOString(), id);
    return Number(result.changes) === 1 ? this.getMeeting(id) : null;
  }

  restoreAudioDeletion(id: string, deletedAt: string): boolean {
    const result = this.db.prepare(`
      UPDATE meetings SET audio_deleted_at = NULL
      WHERE id = ? AND audio_deleted_at = ? AND postprocess_status NOT IN ('queued', 'processing')
    `).run(id, deletedAt);
    return Number(result.changes) === 1;
  }

  deleteMeeting(id: string): boolean {
    const result = this.db.prepare("DELETE FROM meetings WHERE id = ? AND status = 'stopped'").run(id);
    return Number(result.changes) === 1;
  }

  getSetting(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO app_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  getMeeting(id: string): Meeting | null {
    const row = this.db.prepare("SELECT * FROM meetings WHERE id = ?").get(id) as MeetingRow | undefined;
    return row ? this.mapMeeting(row) : null;
  }

  listMeetings(): MeetingSummary[] {
    const rows = this.db.prepare(`
      SELECT m.*,
        (SELECT COUNT(*) FROM transcript_segments WHERE meeting_id = m.id) AS segment_count,
        (SELECT COUNT(*) FROM meeting_speakers WHERE meeting_id = m.id) AS speaker_count
      FROM meetings m
      ORDER BY m.started_at DESC
    `).all() as unknown as Array<MeetingRow & { segment_count: number; speaker_count: number }>;

    return rows.map((row) => ({
      ...this.mapMeeting(row),
      viewerCode: row.viewer_code,
      segmentCount: Number(row.segment_count || 0),
      speakerCount: Number(row.speaker_count || 0),
    }));
  }

  stopMeeting(id: string, audioDurationMs = 0, estimatedCostUsd = 0): Meeting | null {
    const stoppedAt = new Date().toISOString();
    this.db.prepare(`
      UPDATE meetings
      SET status = 'stopped', stopped_at = ?, audio_duration_ms = ?, estimated_cost_usd = ?
      WHERE id = ? AND status = 'recording'
    `).run(stoppedAt, audioDurationMs, estimatedCostUsd, id);
    return this.getMeeting(id);
  }

  queuePostprocess(id: string): Meeting | null {
    const requestedAt = new Date().toISOString();
    const result = this.db.prepare(`
      UPDATE meetings
      SET postprocess_status = 'queued', postprocess_requested_at = ?,
          postprocess_completed_at = NULL, postprocess_error = NULL, assembly_transcript_id = NULL
      WHERE id = ? AND status = 'stopped' AND audio_deleted_at IS NULL
        AND postprocess_status IN ('not_requested', 'failed')
    `).run(requestedAt, id);
    return Number(result.changes) === 1 ? this.getMeeting(id) : null;
  }

  markPostprocessProcessing(id: string): Meeting | null {
    this.db.prepare("UPDATE meetings SET postprocess_status = 'processing' WHERE id = ? AND postprocess_status = 'queued'").run(id);
    return this.getMeeting(id);
  }

  completePostprocess(id: string, transcriptId: string): Meeting | null {
    this.db.prepare(`
      UPDATE meetings
      SET postprocess_status = 'completed', postprocess_completed_at = ?,
          postprocess_error = NULL, assembly_transcript_id = ?
      WHERE id = ?
    `).run(new Date().toISOString(), transcriptId, id);
    return this.getMeeting(id);
  }

  failPostprocess(id: string, error: string): Meeting | null {
    this.db.prepare(`
      UPDATE meetings
      SET postprocess_status = 'failed', postprocess_completed_at = ?, postprocess_error = ?
      WHERE id = ?
    `).run(new Date().toISOString(), error.slice(0, 1_000), id);
    return this.getMeeting(id);
  }

  beginReadableGeneration(id: string, characterCount: number, model: string): Meeting | null {
    const result = this.db.prepare(`
      UPDATE meetings
      SET readable_status = 'processing', readable_character_count = ?, readable_model = ?,
          readable_requested_at = ?, readable_completed_at = NULL, readable_error = NULL
      WHERE id = ? AND status = 'stopped' AND readable_status != 'processing'
    `).run(characterCount, model, new Date().toISOString(), id);
    return Number(result.changes) === 1 ? this.getMeeting(id) : null;
  }

  completeReadableGeneration(id: string): Meeting | null {
    this.db.prepare(`
      UPDATE meetings SET readable_status = 'completed', readable_completed_at = ?, readable_error = NULL
      WHERE id = ?
    `).run(new Date().toISOString(), id);
    return this.getMeeting(id);
  }

  failReadableGeneration(id: string, error: string): Meeting | null {
    this.db.prepare(`
      UPDATE meetings SET readable_status = 'failed', readable_completed_at = ?, readable_error = ?
      WHERE id = ?
    `).run(new Date().toISOString(), error.slice(0, 1_000), id);
    return this.getMeeting(id);
  }

  saveReadableVariants(
    meetingId: string,
    model: string,
    candidates: Array<{ segmentId: string; sourceText: string; text: string }>,
  ): ReadableVariant[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const candidate of candidates) {
        const segment = this.db.prepare("SELECT text FROM transcript_segments WHERE id = ? AND meeting_id = ?")
          .get(candidate.segmentId, meetingId) as { text: string } | undefined;
        if (!segment || segment.text !== candidate.sourceText) throw new Error("逐字稿在易讀版產生期間已被修改，請重新執行");
        const versionRow = this.db.prepare(`
          SELECT COALESCE(MAX(version), 0) + 1 AS next_version
          FROM transcript_readable_variants WHERE segment_id = ?
        `).get(candidate.segmentId) as { next_version: number };
        this.db.prepare(`
          INSERT INTO transcript_readable_variants
            (id, meeting_id, segment_id, version, source_text_hash, text, status, model, created_at, reviewed_at)
          VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, NULL)
        `).run(
          crypto.randomUUID(),
          meetingId,
          candidate.segmentId,
          versionRow.next_version,
          this.hashText(candidate.sourceText),
          candidate.text,
          model,
          new Date().toISOString(),
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.listReadableVariants(meetingId);
  }

  listReadableVariants(meetingId: string): ReadableVariant[] {
    const rows = this.db.prepare(`
      SELECT variant.*, segment.text AS current_text
      FROM transcript_readable_variants variant
      JOIN transcript_segments segment ON segment.id = variant.segment_id
      JOIN (
        SELECT segment_id, MAX(version) AS latest_version
        FROM transcript_readable_variants WHERE meeting_id = ? GROUP BY segment_id
      ) latest ON latest.segment_id = variant.segment_id AND latest.latest_version = variant.version
      WHERE variant.meeting_id = ?
      ORDER BY segment.start_ms, variant.created_at
    `).all(meetingId, meetingId) as unknown as ReadableVariantRow[];
    return rows.map((row) => this.mapReadableVariant(row));
  }

  reviewReadableVariant(meetingId: string, variantId: string, status: "accepted" | "rejected"): ReadableVariant | null {
    const row = this.db.prepare(`
      SELECT variant.*, segment.text AS current_text
      FROM transcript_readable_variants variant
      JOIN transcript_segments segment ON segment.id = variant.segment_id
      WHERE variant.id = ? AND variant.meeting_id = ?
        AND variant.version = (
          SELECT MAX(latest.version) FROM transcript_readable_variants latest
          WHERE latest.segment_id = variant.segment_id
        )
    `).get(variantId, meetingId) as ReadableVariantRow | undefined;
    if (!row || this.hashText(row.current_text) !== row.source_text_hash) return null;
    if (status === "accepted") {
      this.db.prepare(`
        UPDATE transcript_readable_variants SET status = 'rejected', reviewed_at = ?
        WHERE segment_id = ? AND status = 'accepted'
      `).run(new Date().toISOString(), row.segment_id);
    }
    this.db.prepare(`
      UPDATE transcript_readable_variants SET status = ?, reviewed_at = ?
      WHERE id = ? AND meeting_id = ?
    `).run(status, new Date().toISOString(), variantId, meetingId);
    return this.listReadableVariants(meetingId).find((variant) => variant.id === variantId) ?? null;
  }

  listReadableSegments(meetingId: string): TranscriptSegment[] {
    const segments = this.listSegments(meetingId);
    const accepted = new Map(
      this.listReadableVariants(meetingId)
        .filter((variant) => variant.status === "accepted" && !variant.isStale)
        .map((variant) => [variant.segmentId, variant.text]),
    );
    return segments.map((segment) => ({ ...segment, text: accepted.get(segment.id) ?? segment.text }));
  }

  recoverInterruptedWork(): number {
    const now = new Date().toISOString();
    const postprocess = this.db.prepare(`
      UPDATE meetings
      SET postprocess_status = 'failed', postprocess_completed_at = ?,
          postprocess_error = '服務重新啟動，前次會後講者修正未完成；重新送出前請確認供應商帳務'
      WHERE postprocess_status IN ('queued', 'processing')
    `).run(now);
    const readable = this.db.prepare(`
      UPDATE meetings
      SET readable_status = 'failed', readable_completed_at = ?,
          readable_error = '服務重新啟動，前次易讀版產生工作未完成，請重新執行'
      WHERE readable_status = 'processing'
    `).run(now);
    return Number(postprocess.changes) + Number(readable.changes);
  }

  addSegment(input: Omit<TranscriptSegment, "id" | "createdAt" | "speakerId">): TranscriptSegment {
    const profile = this.ensureSpeakerForLabel(input.meetingId, input.speaker);
    const segment: TranscriptSegment = {
      ...input,
      speakerId: profile.id,
      speaker: profile.displayName,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO transcript_segments
        (id, meeting_id, start_ms, end_ms, text, speaker_id, speaker, speaker_confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      segment.id,
      segment.meetingId,
      segment.startMs,
      segment.endMs,
      segment.text,
      segment.speakerId,
      segment.speaker,
      segment.speakerConfidence,
      segment.createdAt,
    );
    return segment;
  }

  updateSegmentSpeaker(id: string, speaker: string, confidence: number | null): TranscriptSegment | null {
    const current = this.db.prepare(`
      SELECT meeting_id, speaker_id FROM transcript_segments WHERE id = ?
    `).get(id) as { meeting_id: string; speaker_id: string } | undefined;
    if (!current) return null;
    let profile = this.getSpeakerBySourceLabel(current.meeting_id, speaker);
    if (!profile && current.speaker_id) {
      const currentProfile = this.getSpeaker(current.meeting_id, current.speaker_id);
      if (currentProfile?.isCustomName) {
        this.db.prepare("UPDATE meeting_speakers SET source_label = ? WHERE id = ?").run(speaker, currentProfile.id);
        profile = { ...currentProfile, sourceLabel: speaker };
      }
    }
    profile ??= this.ensureSpeakerForLabel(current.meeting_id, speaker);
    this.db.prepare(
      "UPDATE transcript_segments SET speaker_id = ?, speaker = ?, speaker_confidence = ? WHERE id = ?",
    ).run(profile.id, profile.displayName, confidence, id);
    const row = this.db.prepare("SELECT * FROM transcript_segments WHERE id = ?").get(id) as SegmentRow | undefined;
    return row ? this.mapSegment(row) : null;
  }

  updateSegmentText(meetingId: string, id: string, text: string): TranscriptSegment | null {
    this.db.prepare(
      "UPDATE transcript_segments SET text = ? WHERE id = ? AND meeting_id = ?",
    ).run(text, id, meetingId);
    const row = this.db.prepare(
      "SELECT * FROM transcript_segments WHERE id = ? AND meeting_id = ?",
    ).get(id, meetingId) as SegmentRow | undefined;
    return row ? this.mapSegment(row) : null;
  }

  renameSpeaker(meetingId: string, speakerId: string, newName: string): { speaker: MeetingSpeaker; segments: TranscriptSegment[] } | null {
    const existing = this.getSpeaker(meetingId, speakerId);
    if (!existing) return null;
    this.db.prepare(`
      UPDATE meeting_speakers SET display_name = ?, is_custom_name = 1
      WHERE id = ? AND meeting_id = ?
    `).run(newName, speakerId, meetingId);
    this.db.prepare(`
      UPDATE transcript_segments SET speaker = ?
      WHERE meeting_id = ? AND speaker_id = ?
    `).run(newName, meetingId, speakerId);
    const rows = this.db.prepare(`
      SELECT * FROM transcript_segments
      WHERE meeting_id = ? AND speaker_id = ?
      ORDER BY start_ms, created_at
    `).all(meetingId, speakerId) as unknown as SegmentRow[];
    return { speaker: this.getSpeaker(meetingId, speakerId)!, segments: rows.map((row) => this.mapSegment(row)) };
  }

  createSpeaker(meetingId: string, displayName: string): MeetingSpeaker {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO meeting_speakers
        (id, meeting_id, source_label, display_name, is_custom_name, created_at)
      VALUES (?, ?, ?, ?, 1, ?)
    `).run(id, meetingId, `manual:${id}`, displayName, createdAt);
    return this.getSpeaker(meetingId, id)!;
  }

  assignSegmentSpeaker(meetingId: string, segmentId: string, speakerId: string): TranscriptSegment | null {
    const speaker = this.getSpeaker(meetingId, speakerId);
    if (!speaker) return null;
    this.db.prepare(`
      UPDATE transcript_segments SET speaker_id = ?, speaker = ?, speaker_confidence = NULL
      WHERE id = ? AND meeting_id = ?
    `).run(speaker.id, speaker.displayName, segmentId, meetingId);
    const row = this.db.prepare("SELECT * FROM transcript_segments WHERE id = ? AND meeting_id = ?")
      .get(segmentId, meetingId) as SegmentRow | undefined;
    return row ? this.mapSegment(row) : null;
  }

  mergeSpeakers(meetingId: string, sourceSpeakerId: string, targetSpeakerId: string): TranscriptSegment[] | null {
    if (sourceSpeakerId === targetSpeakerId) return null;
    const source = this.getSpeaker(meetingId, sourceSpeakerId);
    const target = this.getSpeaker(meetingId, targetSpeakerId);
    if (!source || !target) return null;
    this.db.prepare(`
      UPDATE transcript_segments SET speaker_id = ?, speaker = ?
      WHERE meeting_id = ? AND speaker_id = ?
    `).run(target.id, target.displayName, meetingId, source.id);
    this.db.prepare("DELETE FROM meeting_speakers WHERE id = ? AND meeting_id = ?").run(source.id, meetingId);
    return this.listSegments(meetingId).filter((segment) => segment.speakerId === target.id);
  }

  listSpeakers(meetingId: string): MeetingSpeaker[] {
    const rows = this.db.prepare(`
      SELECT * FROM meeting_speakers WHERE meeting_id = ? ORDER BY created_at, id
    `).all(meetingId) as unknown as SpeakerRow[];
    return rows.map((row) => this.mapSpeaker(row));
  }

  listSegments(meetingId: string): TranscriptSegment[] {
    const rows = this.db.prepare(
      "SELECT * FROM transcript_segments WHERE meeting_id = ? ORDER BY start_ms, created_at",
    ).all(meetingId) as unknown as SegmentRow[];
    return rows.map((row) => this.mapSegment(row));
  }

  close(): void {
    this.db.close();
  }

  private mapMeeting(row: MeetingRow): Meeting {
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      startedAt: row.started_at,
      stoppedAt: row.stopped_at,
      postprocess: {
        status: row.postprocess_status,
        audioDurationMs: row.audio_duration_ms,
        estimatedCostUsd: row.estimated_cost_usd,
        requestedAt: row.postprocess_requested_at,
        completedAt: row.postprocess_completed_at,
        error: row.postprocess_error,
        transcriptId: row.assembly_transcript_id,
      },
      readable: {
        status: row.readable_status,
        characterCount: row.readable_character_count,
        model: row.readable_model,
        requestedAt: row.readable_requested_at,
        completedAt: row.readable_completed_at,
        error: row.readable_error,
      },
      recording: { audioDeletedAt: row.audio_deleted_at },
    };
  }

  private mapSegment(row: SegmentRow): TranscriptSegment {
    return {
      id: row.id,
      meetingId: row.meeting_id,
      startMs: row.start_ms,
      endMs: row.end_ms,
      text: row.text,
      speakerId: row.speaker_id,
      speaker: row.speaker,
      speakerConfidence: row.speaker_confidence,
      createdAt: row.created_at,
    };
  }

  private ensureMeetingColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(meetings)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE meetings ADD COLUMN ${name} ${definition}`);
    }
  }

  private ensureSegmentColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(transcript_segments)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === name)) {
      this.db.exec(`ALTER TABLE transcript_segments ADD COLUMN ${name} ${definition}`);
    }
  }

  private backfillSpeakerProfiles(): void {
    const rows = this.db.prepare(`
      SELECT DISTINCT meeting_id, speaker
      FROM transcript_segments
      WHERE speaker_id IS NULL OR speaker_id = ''
    `).all() as unknown as Array<{ meeting_id: string; speaker: string }>;
    for (const row of rows) {
      const isCustomName = !/^講者 \d+$/.test(row.speaker);
      const profile = this.ensureSpeakerForLabel(row.meeting_id, row.speaker, isCustomName);
      this.db.prepare(`
        UPDATE transcript_segments SET speaker_id = ?
        WHERE meeting_id = ? AND speaker = ? AND (speaker_id IS NULL OR speaker_id = '')
      `).run(profile.id, row.meeting_id, row.speaker);
    }
  }

  private ensureSpeakerForLabel(meetingId: string, sourceLabel: string, isCustomName = false): MeetingSpeaker {
    const existing = this.getSpeakerBySourceLabel(meetingId, sourceLabel);
    if (existing) return existing;
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO meeting_speakers
        (id, meeting_id, source_label, display_name, is_custom_name, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, meetingId, sourceLabel, sourceLabel, isCustomName ? 1 : 0, createdAt);
    return this.getSpeaker(meetingId, id)!;
  }

  private getSpeaker(meetingId: string, speakerId: string): MeetingSpeaker | null {
    const row = this.db.prepare(`
      SELECT * FROM meeting_speakers WHERE meeting_id = ? AND id = ?
    `).get(meetingId, speakerId) as SpeakerRow | undefined;
    return row ? this.mapSpeaker(row) : null;
  }

  private getSpeakerBySourceLabel(meetingId: string, sourceLabel: string): MeetingSpeaker | null {
    const row = this.db.prepare(`
      SELECT * FROM meeting_speakers WHERE meeting_id = ? AND source_label = ?
    `).get(meetingId, sourceLabel) as SpeakerRow | undefined;
    return row ? this.mapSpeaker(row) : null;
  }

  private mapSpeaker(row: SpeakerRow): MeetingSpeaker {
    return {
      id: row.id,
      meetingId: row.meeting_id,
      sourceLabel: row.source_label,
      displayName: row.display_name,
      isCustomName: Boolean(row.is_custom_name),
      createdAt: row.created_at,
    };
  }

  private mapReadableVariant(row: ReadableVariantRow): ReadableVariant {
    return {
      id: row.id,
      meetingId: row.meeting_id,
      segmentId: row.segment_id,
      version: row.version,
      sourceTextHash: row.source_text_hash,
      text: row.text,
      status: row.status,
      model: row.model,
      createdAt: row.created_at,
      reviewedAt: row.reviewed_at,
      isStale: this.hashText(row.current_text) !== row.source_text_hash,
    };
  }

  private hashText(text: string): string {
    return createHash("sha256").update(text, "utf8").digest("hex");
  }
}
