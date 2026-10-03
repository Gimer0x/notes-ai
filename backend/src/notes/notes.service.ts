import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BillingService } from '../billing/billing.service';
import { DbService } from '../db/db.service';
import { SummaryService, type MeetingLanguage } from '../summary/summary.service';
import { toNote, type NoteResponse, type NoteRow, type TranscriptTurn } from './note.types';
import { WorkspacesService } from './workspaces.service';

const TITLE_MAX = 120;
const NOTE_COLUMNS = `id, workspace_id, title, status, summary_text, transcript_text, transcript_turns, language,
  error_code, error_message, started_at, ended_at, duration_seconds, created_at, updated_at`;

@Injectable()
export class NotesService {
  constructor(
    private readonly db: DbService,
    private readonly workspaces: WorkspacesService,
    private readonly billing: BillingService,
    private readonly summary: SummaryService,
  ) {}

  async list(userId: string, workspaceId: string): Promise<NoteResponse[]> {
    await this.workspaces.assertOwned(userId, workspaceId);
    const result = await this.db.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS}
       FROM notes
       WHERE workspace_id = $1 AND user_id = $2
       ORDER BY COALESCE(started_at, created_at) DESC`,
      [workspaceId, userId],
    );
    return result.rows.map(toNote);
  }

  async create(
    userId: string,
    workspaceId: string,
    title: string | null,
  ): Promise<NoteResponse> {
    await this.workspaces.assertOwned(userId, workspaceId);
    const gate = await this.billing.canStartNote(userId);
    if (!gate.allowed) {
      throw new ForbiddenException(gate.reason ?? 'not_allowed');
    }
    const result = await this.db.query<NoteRow>(
      `INSERT INTO notes (workspace_id, user_id, title, status, started_at)
       VALUES ($1, $2, $3, 'listening', now())
       RETURNING ${NOTE_COLUMNS}`,
      [workspaceId, userId, cleanTitle(title)],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('note insert failed');
    }
    return toNote(row);
  }

  async get(userId: string, noteId: string): Promise<NoteResponse> {
    return toNote(await this.require(userId, noteId));
  }

  async rename(userId: string, noteId: string, title: string | null): Promise<NoteResponse> {
    await this.require(userId, noteId);
    const result = await this.db.query<NoteRow>(
      `UPDATE notes
       SET title = $3, updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING ${NOTE_COLUMNS}`,
      [noteId, userId, cleanTitle(title)],
    );
    return toNote(requiredRow(result.rows[0]));
  }

  async move(userId: string, noteId: string, workspaceId: string): Promise<NoteResponse> {
    await this.require(userId, noteId);
    await this.workspaces.assertOwned(userId, workspaceId);
    const result = await this.db.query<NoteRow>(
      `UPDATE notes
       SET workspace_id = $3, updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING ${NOTE_COLUMNS}`,
      [noteId, userId, workspaceId],
    );
    return toNote(requiredRow(result.rows[0]));
  }

  async remove(userId: string, noteId: string): Promise<void> {
    const note = await this.require(userId, noteId);
    if (note.status === 'processing') {
      throw new ConflictException('note_processing');
    }
    await this.db.query(`DELETE FROM notes WHERE id = $1 AND user_id = $2`, [noteId, userId]);
  }

  async cancel(userId: string, noteId: string): Promise<void> {
    const note = await this.require(userId, noteId);
    if (note.status !== 'listening' && note.status !== 'paused') {
      throw new ConflictException('not_listening');
    }
    await this.db.query(`DELETE FROM notes WHERE id = $1 AND user_id = $2`, [noteId, userId]);
  }

  /** Ends the listen, keeps the transcript, and writes summary bullets. */
  async stop(
    userId: string,
    noteId: string,
    durationSeconds: number,
    transcriptText?: string | null,
    language?: 'en' | 'es' | null,
    turns?: TranscriptTurn[] | null,
  ): Promise<NoteResponse> {
    const note = await this.require(userId, noteId);
    if (note.status !== 'listening' && note.status !== 'paused') {
      throw new ConflictException('not_listening');
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new BadRequestException('duration_seconds');
    }
    const languageCode = language === 'en' || language === 'es' ? language : null;
    const transcript = cleanTranscript(transcriptText);
    const savedTurns = cleanTurns(turns);
    await this.billing.recordListen(userId, durationSeconds);
    const stored = await this.db.query<NoteRow>(
      `UPDATE notes
       SET status = 'processing',
           ended_at = now(),
           duration_seconds = $3,
           transcript_text = $4,
           transcript_turns = $5,
           language = $6,
           error_code = NULL,
           error_message = NULL,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING ${NOTE_COLUMNS}`,
      [
        noteId,
        userId,
        Math.round(durationSeconds),
        transcript,
        savedTurns ? JSON.stringify(savedTurns) : null,
        languageCode,
      ],
    );
    requiredRow(stored.rows[0]);
    if (!transcript) {
      return this.markReady(userId, noteId, null);
    }
    return this.writeSummary(userId, noteId, transcript, languageCode ?? 'en');
  }

  async retry(userId: string, noteId: string): Promise<NoteResponse> {
    const note = await this.require(userId, noteId);
    if (note.status !== 'failed') {
      throw new ConflictException('not_failed');
    }
    const transcript = cleanTranscript(note.transcript_text);
    if (!transcript) {
      throw new ConflictException('record_again');
    }
    const language = note.language === 'es' ? 'es' : 'en';
    return this.writeSummary(userId, noteId, transcript, language);
  }

  private async writeSummary(
    userId: string,
    noteId: string,
    transcript: string,
    language: MeetingLanguage,
  ): Promise<NoteResponse> {
    try {
      const summary = await this.summary.summarize(transcript, language);
      return this.markReady(userId, noteId, summary.bullets.join('\n'));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'summary_failed';
      const result = await this.db.query<NoteRow>(
        `UPDATE notes
         SET status = 'failed',
             error_code = 'gpt',
             error_message = $3,
             updated_at = now()
         WHERE id = $1 AND user_id = $2
         RETURNING ${NOTE_COLUMNS}`,
        [noteId, userId, message.slice(0, 500)],
      );
      return toNote(requiredRow(result.rows[0]));
    }
  }

  private async markReady(
    userId: string,
    noteId: string,
    summaryText: string | null,
  ): Promise<NoteResponse> {
    const result = await this.db.query<NoteRow>(
      `UPDATE notes
       SET status = 'ready',
           summary_text = $3,
           error_code = NULL,
           error_message = NULL,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING ${NOTE_COLUMNS}`,
      [noteId, userId, summaryText],
    );
    return toNote(requiredRow(result.rows[0]));
  }

  private async require(userId: string, noteId: string): Promise<NoteRow> {
    const result = await this.db.query<NoteRow>(
      `SELECT ${NOTE_COLUMNS}
       FROM notes
       WHERE id = $1 AND user_id = $2`,
      [noteId, userId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException('note_not_found');
    }
    return row;
  }
}

function requiredRow(row: NoteRow | undefined): NoteRow {
  if (!row) {
    throw new Error('note update failed');
  }
  return row;
}

function cleanTurns(value: TranscriptTurn[] | null | undefined): TranscriptTurn[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const turns: TranscriptTurn[] = [];
  for (const item of value) {
    if (!item || (item.source !== 'mic' && item.source !== 'system' && item.source !== 'mix')) {
      continue;
    }
    const text = typeof item.text === 'string' ? item.text.trim() : '';
    if (!text) {
      continue;
    }
    turns.push({
      source: item.source,
      startSec: Number(item.startSec) || 0,
      endSec: Number(item.endSec) || 0,
      text,
    });
  }
  return turns.length > 0 ? turns : null;
}

function cleanTranscript(value: string | null | undefined): string | null {
  if (value == null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function cleanTitle(title: string | null | undefined): string | null {
  if (title == null) {
    return null;
  }
  const trimmed = title.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > TITLE_MAX) {
    throw new BadRequestException('note_title');
  }
  return trimmed;
}
