import { readFile, unlink, mkdir, writeFile } from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { BillingService } from '../billing/billing.service';
import { DbService } from '../db/db.service';
import { cleanSpeech } from '../notes/clean-speech';
import { SummaryService } from '../summary/summary.service';
import { OpenAiTranscribeService } from '../transcribe/openai-transcribe.service';

const MAX_IN_FLIGHT = 2;
const MAX_ATTEMPTS = 3;

const CLAIM_SQL = `SELECT s.id, s.note_id, s.user_id, s.seq, s.status, s.source, s.start_sec, s.end_sec,
                s.wav_path, s.transcript, s.language, s.attempts,
                n.final_seq, n.typed_notes, n.status AS note_status
         FROM note_slices s
         JOIN notes n ON n.id = s.note_id
         WHERE s.status = 'queued'`;

const FAIR_FILTER = `
           AND s.user_id NOT IN (
             SELECT user_id FROM note_slices WHERE status = 'running'
           )`;

const CLAIM_TAIL = `
         ORDER BY s.created_at
         FOR UPDATE OF s SKIP LOCKED
         LIMIT 1`;

type SliceSource = 'mic' | 'system' | 'mix';

type SliceRow = {
  id: string;
  note_id: string;
  user_id: string;
  seq: number;
  status: 'queued' | 'running' | 'done' | 'failed';
  source: SliceSource;
  start_sec: number;
  end_sec: number;
  wav_path: string | null;
  transcript: string | null;
  language: 'en' | 'es' | null;
  attempts: number;
  final_seq: number | null;
  typed_notes: string | null;
  note_status: string;
};

export type SliceProgress = {
  done: number;
  total: number;
  failed: number;
  status: string;
};

@Injectable()
export class SlicesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SlicesService.name);
  private timer: NodeJS.Timeout | null = null;
  private inFlight = 0;
  private ticking = false;

  constructor(
    private readonly db: DbService,
    private readonly billing: BillingService,
    private readonly summary: SummaryService,
    private readonly transcribe: OpenAiTranscribeService,
  ) {}

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      return;
    }
    this.timer = setInterval(() => {
      void this.tick();
    }, 400);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async accept(input: {
    userId: string;
    noteId: string;
    seq: number;
    source: SliceSource;
    startSec: number;
    endSec: number;
    wav: Buffer;
  }): Promise<{ sliceId: string }> {
    if (!Number.isInteger(input.seq) || input.seq < 1) {
      throw new BadRequestException('seq');
    }
    const note = await this.ownedNote(input.userId, input.noteId);
    if (note.status !== 'listening' && note.status !== 'paused' && note.status !== 'processing') {
      throw new ConflictException('not_listening');
    }
    const dir = await this.sliceDir();
    const wavPath = path.join(dir, `${input.noteId}-${input.seq}.wav`);
    await writeFile(wavPath, input.wav);
    const saved = await this.db.query<{ id: string }>(
      `INSERT INTO note_slices (
         note_id, user_id, seq, status, source, start_sec, end_sec, wav_path
       ) VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7)
       ON CONFLICT (note_id, seq) DO UPDATE
         SET status = 'queued',
             source = EXCLUDED.source,
             start_sec = EXCLUDED.start_sec,
             end_sec = EXCLUDED.end_sec,
             wav_path = EXCLUDED.wav_path,
             transcript = NULL,
             language = NULL,
             attempts = 0,
             locked_at = NULL,
             finished_at = NULL
         WHERE note_slices.status IN ('queued', 'failed')
       RETURNING id`,
      [
        input.noteId,
        input.userId,
        input.seq,
        input.source,
        input.startSec,
        input.endSec,
        wavPath,
      ],
    );
    const row = saved.rows[0];
    if (!row) {
      const existing = await this.db.query<{ id: string }>(
        `SELECT id FROM note_slices WHERE note_id = $1 AND seq = $2`,
        [input.noteId, input.seq],
      );
      await unlink(wavPath).catch(() => undefined);
      const id = existing.rows[0]?.id;
      if (!id) {
        throw new ConflictException('slice_closed');
      }
      return { sliceId: id };
    }
    void this.tick();
    return { sliceId: row.id };
  }

  async progress(userId: string, noteId: string): Promise<SliceProgress> {
    const note = await this.ownedNote(userId, noteId);
    const counts = await this.db.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count
       FROM note_slices
       WHERE note_id = $1
       GROUP BY status`,
      [noteId],
    );
    let done = 0;
    let failed = 0;
    let total = 0;
    for (const row of counts.rows) {
      const count = Number(row.count);
      total += count;
      if (row.status === 'done') {
        done = count;
      }
      if (row.status === 'failed') {
        failed = count;
      }
    }
    return { done, total, failed, status: note.status };
  }

  async seal(input: {
    userId: string;
    noteId: string;
    finalSeq: number;
    durationSeconds: number;
    typedNotes: string;
  }): Promise<void> {
    if (!Number.isInteger(input.finalSeq) || input.finalSeq < 0) {
      throw new BadRequestException('final_seq');
    }
    if (!Number.isFinite(input.durationSeconds) || input.durationSeconds < 0) {
      throw new BadRequestException('duration_seconds');
    }
    const updated = await this.db.query(
      `UPDATE notes
       SET status = 'processing',
           final_seq = $3,
           typed_notes = $4,
           ended_at = now(),
           duration_seconds = $5,
           updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status IN ('listening', 'paused')
       RETURNING id`,
      [
        input.noteId,
        input.userId,
        input.finalSeq,
        input.typedNotes.trim() || null,
        Math.round(input.durationSeconds),
      ],
    );
    if (updated.rows[0]) {
      await this.billing.recordListen(input.userId, input.durationSeconds);
    }
    await this.maybeSummarize(input.noteId);
  }

  private async tick(): Promise<void> {
    if (this.ticking) {
      return;
    }
    this.ticking = true;
    try {
      await this.recoverStale();
      await this.purgeFailedAudio();
      while (this.inFlight < MAX_IN_FLIGHT) {
        const job = await this.claim();
        if (!job) {
          break;
        }
        this.inFlight += 1;
        void this.run(job)
          .catch((error: unknown) => {
            this.logger.warn(error instanceof Error ? error.message : 'slice_failed');
          })
          .finally(() => {
            this.inFlight -= 1;
            void this.maybeSummarize(job.note_id);
          });
      }
    } finally {
      this.ticking = false;
    }
  }

  private async claim(): Promise<SliceRow | null> {
    return this.db.transaction(async (query) => {
      const fair = await query<SliceRow>(CLAIM_SQL + FAIR_FILTER + CLAIM_TAIL);
      const picked = fair.rows[0]
        ? fair
        : await query<SliceRow>(CLAIM_SQL + CLAIM_TAIL);
      const row = picked.rows[0];
      if (!row) {
        return null;
      }
      await query(
        `UPDATE note_slices
         SET status = 'running', locked_at = now(), attempts = attempts + 1
         WHERE id = $1`,
        [row.id],
      );
      return { ...row, attempts: row.attempts + 1, status: 'running' };
    });
  }

  private async run(job: SliceRow): Promise<void> {
    try {
      if (!job.wav_path) {
        throw new Error('missing_wav');
      }
      const wav = await readFile(job.wav_path);
      const result = await this.transcribe.transcribeBuffers([wav], `${job.source}-${job.seq}.wav`);
      const text = cleanSpeech(result.transcript);
      await this.db.query(
        `UPDATE note_slices
         SET status = 'done',
             transcript = $2,
             language = $3,
             wav_path = NULL,
             finished_at = now()
         WHERE id = $1`,
        [job.id, text, result.language],
      );
      await unlink(job.wav_path).catch(() => undefined);
    } catch (error) {
      const failedForGood = job.attempts >= MAX_ATTEMPTS;
      await this.db.query(
        `UPDATE note_slices
         SET status = $2,
             locked_at = NULL,
             finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
         WHERE id = $1`,
        [job.id, failedForGood ? 'failed' : 'queued'],
      );
      if (failedForGood) {
        this.logger.warn(
          `slice ${job.note_id}#${job.seq} failed: ${error instanceof Error ? error.message : 'stt'}`,
        );
      }
    }
  }

  private async maybeSummarize(noteId: string): Promise<void> {
    const note = await this.db.query<{
      final_seq: number | null;
      typed_notes: string | null;
      status: string;
      summary_running: boolean;
    }>(
      `SELECT final_seq, typed_notes, status, summary_running
       FROM notes WHERE id = $1`,
      [noteId],
    );
    const row = note.rows[0];
    if (!row || row.status !== 'processing' || row.summary_running || row.final_seq == null) {
      return;
    }
    const slices = await this.db.query<{
      seq: number;
      status: string;
      transcript: string | null;
      language: 'en' | 'es' | null;
      source: SliceSource;
      start_sec: number;
      end_sec: number;
      wav_path: string | null;
    }>(
      `SELECT seq, status, transcript, language, source, start_sec, end_sec, wav_path
       FROM note_slices
       WHERE note_id = $1 AND seq <= $2
       ORDER BY seq`,
      [noteId, row.final_seq],
    );
    if (slices.rows.some((slice) => slice.status === 'queued' || slice.status === 'running')) {
      return;
    }
    const failed = slices.rows.filter((slice) => slice.status === 'failed');
    if (failed.length > 0) {
      await this.finishFailed(noteId, slices.rows);
      return;
    }
    if (slices.rows.length !== row.final_seq) {
      return;
    }
    const claimed = await this.db.query(
      `UPDATE notes SET summary_running = true, updated_at = now()
       WHERE id = $1 AND status = 'processing' AND summary_running = false
       RETURNING id`,
      [noteId],
    );
    if (!claimed.rows[0]) {
      return;
    }
    const turns = slices.rows
      .map((slice) => ({
        source: slice.source,
        startSec: slice.start_sec,
        endSec: slice.end_sec,
        text: (slice.transcript ?? '').trim(),
      }))
      .filter((turn) => turn.text.length > 0);
    const spoken = turns.map((turn) => turn.text).join('\n\n');
    const transcript = [row.typed_notes?.trim() ?? '', spoken].filter((part) => part.length > 0).join('\n\n');
    const language = slices.rows.find((slice) => slice.language)?.language ?? 'en';
    await this.db.query(
      `UPDATE notes
       SET transcript_text = $2,
           transcript_turns = $3,
           language = $4,
           updated_at = now()
       WHERE id = $1`,
      [noteId, transcript || null, turns.length > 0 ? JSON.stringify(turns) : null, language],
    );
    if (!transcript) {
      await this.db.query(
        `UPDATE notes
         SET status = 'ready', summary_text = NULL, summary_running = false, updated_at = now()
         WHERE id = $1`,
        [noteId],
      );
      return;
    }
    try {
      const summary = await this.summary.summarize(transcript, language);
      await this.db.query(
        `UPDATE notes
         SET status = 'ready',
             summary_text = $2,
             summary_running = false,
             error_code = NULL,
             error_message = NULL,
             updated_at = now()
         WHERE id = $1`,
        [noteId, summary.bullets.join('\n')],
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'summary_failed';
      await this.db.query(
        `UPDATE notes
         SET status = 'failed',
             error_code = 'gpt',
             error_message = $2,
             summary_running = false,
             updated_at = now()
         WHERE id = $1`,
        [noteId, message.slice(0, 500)],
      );
    }
  }

  private async finishFailed(
    noteId: string,
    slices: { transcript: string | null; source: SliceSource; start_sec: number; end_sec: number; status: string }[],
  ): Promise<void> {
    const turns = slices
      .filter((slice) => slice.status === 'done' && (slice.transcript ?? '').trim())
      .map((slice) => ({
        source: slice.source,
        startSec: slice.start_sec,
        endSec: slice.end_sec,
        text: (slice.transcript ?? '').trim(),
      }));
    await this.db.query(
      `UPDATE notes
       SET status = 'failed',
           error_code = 'stt',
           error_message = 'slice_failed',
           transcript_text = $2,
           transcript_turns = $3,
           summary_running = false,
           updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [
        noteId,
        turns.map((turn) => turn.text).join('\n\n') || null,
        turns.length > 0 ? JSON.stringify(turns) : null,
      ],
    );
  }

  private async recoverStale(): Promise<void> {
    await this.db.query(
      `UPDATE note_slices
       SET status = 'queued', locked_at = NULL
       WHERE status = 'running' AND locked_at < now() - interval '15 minutes'`,
    );
  }

  private async purgeFailedAudio(): Promise<void> {
    const old = await this.db.query<{ id: string; wav_path: string }>(
      `SELECT id, wav_path
       FROM note_slices
       WHERE status = 'failed'
         AND wav_path IS NOT NULL
         AND finished_at < now() - interval '2 hours'`,
    );
    for (const row of old.rows) {
      await unlink(row.wav_path).catch(() => undefined);
      await this.db.query(`UPDATE note_slices SET wav_path = NULL WHERE id = $1`, [row.id]);
    }
  }

  private async ownedNote(userId: string, noteId: string): Promise<{ status: string }> {
    const result = await this.db.query<{ status: string }>(
      `SELECT status FROM notes WHERE id = $1 AND user_id = $2`,
      [noteId, userId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new NotFoundException('note_not_found');
    }
    return row;
  }

  private async sliceDir(): Promise<string> {
    const dir = path.join(os.tmpdir(), 'pith-slices');
    await mkdir(dir, { recursive: true });
    return dir;
  }
}
