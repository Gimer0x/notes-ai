import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BillingService } from '../billing/billing.service';
import { DbService } from '../db/db.service';
import { toNote, type NoteResponse, type NoteRow } from './note.types';
import { WorkspacesService } from './workspaces.service';

const TITLE_MAX = 120;
const NOTE_COLUMNS = `id, workspace_id, title, status, summary_text, transcript_text, language,
  error_code, error_message, started_at, ended_at, duration_seconds, created_at, updated_at`;

@Injectable()
export class NotesService {
  constructor(
    private readonly db: DbService,
    private readonly workspaces: WorkspacesService,
    private readonly billing: BillingService,
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

  /** Ends the listen and keeps the note. Summary bullets are Step 13. */
  async stop(
    userId: string,
    noteId: string,
    durationSeconds: number,
    transcriptText?: string | null,
    language?: 'en' | 'es' | null,
  ): Promise<NoteResponse> {
    const note = await this.require(userId, noteId);
    if (note.status !== 'listening' && note.status !== 'paused') {
      throw new ConflictException('not_listening');
    }
    if (!Number.isFinite(durationSeconds) || durationSeconds < 0) {
      throw new BadRequestException('duration_seconds');
    }
    const languageCode = language === 'en' || language === 'es' ? language : null;
    const result = await this.db.query<NoteRow>(
      `UPDATE notes
       SET status = 'ready',
           ended_at = now(),
           duration_seconds = $3,
           transcript_text = $4,
           language = $5,
           updated_at = now()
       WHERE id = $1 AND user_id = $2
       RETURNING ${NOTE_COLUMNS}`,
      [noteId, userId, Math.round(durationSeconds), cleanTranscript(transcriptText), languageCode],
    );
    return toNote(requiredRow(result.rows[0]));
  }

  async retry(userId: string, noteId: string): Promise<NoteResponse> {
    const note = await this.require(userId, noteId);
    if (note.status !== 'failed') {
      throw new ConflictException('not_failed');
    }
    throw new ConflictException('record_again');
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
