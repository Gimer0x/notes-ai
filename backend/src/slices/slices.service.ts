import { createHash, randomUUID } from 'crypto';
import { readFile, unlink, mkdir, writeFile } from 'fs/promises';
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
import { assertUuid, safeErrorMessage } from '../common/safe-error';
import { BillingService } from '../billing/billing.service';
import { DbService } from '../db/db.service';
import { cleanSpeech } from '../notes/clean-speech';
import { SummaryService } from '../summary/summary.service';
import { OpenAiTranscribeService } from '../transcribe/openai-transcribe.service';
import { sliceFailureIsFinal, sliceRetryDelaySeconds } from './slice-retry';

function concurrency(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 && value <= 100 ? value : fallback;
}
const MAX_ATTEMPTS = 3;

const CLAIM_SQL = `SELECT s.id, s.note_id, s.user_id, s.seq, s.status, s.source, s.start_sec, s.end_sec,
                s.wav_path, s.transcript, s.language, s.attempts,
                n.final_seq, n.typed_notes, n.status AS note_status
         FROM note_slices s
         JOIN notes n ON n.id = s.note_id
         WHERE s.status = 'queued'
           AND (s.retry_after IS NULL OR s.retry_after <= now())`;

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
  private stopped = false;
  private readonly transcriptionConcurrency = concurrency('TRANSCRIPTION_CONCURRENCY', 2);
  private readonly summaryConcurrency = concurrency('SUMMARY_CONCURRENCY', 2);
  private readonly summarizing = new Set<string>();

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
      void this.tick().catch((error: unknown) => {
        this.logger.warn(error instanceof Error ? error.message : 'slice_tick_failed');
      });
    }, 400);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    this.stopped = true;
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
    assertUuid(input.userId);
    assertUuid(input.noteId);
    if (!Number.isInteger(input.seq) || input.seq < 1) {
      throw new BadRequestException('seq');
    }
    if (
      !Number.isFinite(input.startSec) ||
      !Number.isFinite(input.endSec) ||
      input.endSec < input.startSec
    ) {
      throw new BadRequestException('slice_range');
    }
    const note = await this.ownedNote(input.userId, input.noteId);
    if (note.status !== 'listening' && note.status !== 'paused' && note.status !== 'processing') {
      throw new ConflictException('not_listening');
    }
    const checksum = createHash('sha256').update(input.wav).digest('hex');
    const prior = await this.db.query<{
      id: string;
      status: string;
      wav_path: string | null;
      content_sha256: string | null;
    }>(
      `SELECT id, status, wav_path, content_sha256 FROM note_slices WHERE note_id = $1 AND seq = $2`,
      [input.noteId, input.seq],
    );
    const existing = prior.rows[0];
    if (existing) {
      const same = !existing.content_sha256 || existing.content_sha256 === checksum;
      if (!same) {
        throw new ConflictException('slice_conflict');
      }
      return { sliceId: existing.id };
    }
    const dir = await this.sliceDir();
    const wavPath = path.join(dir, `${input.noteId}-${input.seq}-${randomUUID()}.wav`);
    await writeFile(wavPath, input.wav);
    try {
      const saved = await this.db.query<{ id: string }>(
        `INSERT INTO note_slices (
           note_id, user_id, seq, status, source, start_sec, end_sec, wav_path, content_sha256
         ) VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8)
         ON CONFLICT (note_id, seq) DO UPDATE
           SET status = 'queued',
               source = EXCLUDED.source,
               start_sec = EXCLUDED.start_sec,
               end_sec = EXCLUDED.end_sec,
               wav_path = EXCLUDED.wav_path,
               content_sha256 = EXCLUDED.content_sha256,
               transcript = NULL,
               language = NULL,
               attempts = 0,
               locked_at = NULL,
               retry_after = NULL,
               finished_at = NULL
           WHERE note_slices.status IN ('queued', 'failed')
             AND (
               note_slices.content_sha256 IS NULL
               OR note_slices.content_sha256 = EXCLUDED.content_sha256
             )
         RETURNING id`,
        [
          input.noteId,
          input.userId,
          input.seq,
          input.source,
          input.startSec,
          input.endSec,
          wavPath,
          checksum,
        ],
      );
      const row = saved.rows[0];
      if (!row) {
        await unlink(wavPath).catch(() => undefined);
        throw new ConflictException('slice_conflict');
      }
      void this.tick().catch((error: unknown) => {
        this.logger.warn(error instanceof Error ? error.message : 'slice_tick_failed');
      });
      return { sliceId: row.id };
    } catch (error) {
      await unlink(wavPath).catch(() => undefined);
      throw error;
    }
  }

  /** Re-queue failed slices that still have audio. Returns false when nothing can be retried. */
  async requeueFailedAudio(userId: string, noteId: string): Promise<boolean> {
    const resumed = await this.db.transaction(async (query) => {
      // Serialize Retry with other retries before changing any slice state.
      const note = await query<{ status: string }>(
        `SELECT status FROM notes WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [noteId, userId],
      );
      if (note.rows[0]?.status !== 'failed') {
        return false;
      }
      const updated = await query(
        `UPDATE note_slices
         SET status = 'queued', attempts = 0, locked_at = NULL, finished_at = NULL, retry_after = NULL
         WHERE note_id = $1 AND user_id = $2 AND status = 'failed' AND wav_path IS NOT NULL
         RETURNING id`,
        [noteId, userId],
      );
      if (updated.rows.length === 0) {
        return false;
      }
      await query(
        `UPDATE notes
         SET status = 'processing', summary_running = false, summary_from_transcript = false,
             summary_lease = NULL, summary_lease_until = NULL,
             error_code = NULL, error_message = NULL, updated_at = now()
         WHERE id = $1 AND user_id = $2`,
        [noteId, userId],
      );
      return true;
    });
    return resumed;
  }

  /** Persist summary-only retries; the bounded worker owns provider calls and leases. */
  async queueSummaryRetry(userId: string, noteId: string): Promise<void> {
    const result = await this.db.query(
      `UPDATE notes
       SET status = 'processing', summary_from_transcript = true,
           summary_running = false, summary_lease = NULL, summary_lease_until = NULL,
           error_code = NULL, error_message = NULL, updated_at = now()
       WHERE id = $1 AND user_id = $2 AND status = 'failed'
       RETURNING id`,
      [noteId, userId],
    );
    if (!result.rows[0]) {
      throw new ConflictException('not_failed');
    }
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
    await this.db.transaction(async (query) => {
      const current = await query<{ status: string; final_seq: number | null }>(
        `SELECT status, final_seq FROM notes WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [input.noteId, input.userId],
      );
      const note = current.rows[0];
      if (!note) {
        throw new NotFoundException('note_not_found');
      }
      if (note.status === 'processing' || note.status === 'ready') {
        if (note.final_seq === input.finalSeq) {
          return;
        }
        throw new ConflictException('note_state');
      }
      if (note.status !== 'listening' && note.status !== 'paused') {
        throw new ConflictException('note_state');
      }
      if (input.finalSeq > 0) {
        const present = await query<{ seq: number }>(
          `SELECT seq FROM note_slices WHERE note_id = $1 AND seq <= $2`,
          [input.noteId, input.finalSeq],
        );
        const have = new Set(present.rows.map((row) => Number(row.seq)));
        const missing: number[] = [];
        for (let seq = 1; seq <= input.finalSeq; seq += 1) {
          if (!have.has(seq)) {
            missing.push(seq);
          }
        }
        if (missing.length > 0) {
          throw new ConflictException({ code: 'slices_missing', missing });
        }
      }
      const updated = await query(
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
      if (!updated.rows[0]) {
        throw new ConflictException('note_state');
      }
      await this.billing.recordListen(input.userId, input.noteId, input.durationSeconds, query);
    });
    // The committed processing state is the durable job. Acknowledge before provider work.
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) {
      return;
    }
    this.ticking = true;
    try {
      await this.recoverStale();
      await this.purgeFailedAudio();
      await this.expireMissingSlices();
      await this.resumeSummaries();
      while (this.inFlight < this.transcriptionConcurrency) {
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
            // Refill transcription slots promptly; summaries have their own capacity.
            void this.tick();
          });
      }
    } catch (error) {
      this.logger.warn(error instanceof Error ? error.message : 'slice_tick_failed');
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
      const failedForGood = sliceFailureIsFinal(error, job.attempts, MAX_ATTEMPTS);
      await this.db.query(
        `UPDATE note_slices
         SET status = $2,
             locked_at = NULL,
             retry_after = CASE
               WHEN $2 = 'queued' THEN now() + make_interval(secs => $3)
               ELSE NULL
             END,
             finished_at = CASE WHEN $2 = 'failed' THEN now() ELSE NULL END
         WHERE id = $1`,
        [job.id, failedForGood ? 'failed' : 'queued', sliceRetryDelaySeconds(job.attempts)],
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
      summary_from_transcript: boolean;
      transcript_text: string | null;
      transcript_turns: string | null;
      transcript_complete: boolean;
      language: 'en' | 'es' | null;
    }>(
      `SELECT final_seq, typed_notes, status, summary_running, summary_from_transcript,
              transcript_text, transcript_turns, transcript_complete, language
       FROM notes WHERE id = $1`,
      [noteId],
    );
    const row = note.rows[0];
    if (!row || row.status !== 'processing' || row.summary_running) {
      return;
    }
    let transcript = row.transcript_text ?? '';
    let turnsJson = row.transcript_turns;
    let language = row.language ?? 'en';
    let complete = row.transcript_complete;
    if (!row.summary_from_transcript) {
      if (row.final_seq == null) {
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
         FROM note_slices WHERE note_id = $1 AND seq <= $2 ORDER BY seq`,
        [noteId, row.final_seq],
      );
      if (slices.rows.some((slice) => slice.status === 'queued' || slice.status === 'running')) {
        return;
      }
      if (slices.rows.some((slice) => slice.status === 'failed')) {
        await this.finishFailed(noteId, slices.rows, row.typed_notes);
        return;
      }
      if (slices.rows.length !== row.final_seq) {
        return;
      }
      const turns = slices.rows
        .map((slice) => ({
          source: slice.source, startSec: slice.start_sec, endSec: slice.end_sec,
          text: (slice.transcript ?? '').trim(),
        }))
        .filter((turn) => turn.text.length > 0);
      const spoken = turns.map((turn) => turn.text).join('\n\n');
      transcript = [row.typed_notes?.trim() ?? '', spoken].filter(Boolean).join('\n\n');
      turnsJson = turns.length > 0 ? JSON.stringify(turns) : null;
      language = slices.rows.find((slice) => slice.language)?.language ?? 'en';
      complete = true;
    }
    const lease = randomUUID();
    const claimed = await this.db.query(
      `UPDATE notes
       SET summary_running = true,
           summary_lease = $2,
           summary_lease_until = now() + interval '15 minutes',
           summary_attempts = summary_attempts + 1,
           updated_at = now()
       WHERE id = $1
         AND status = 'processing'
         AND (
           summary_running = false
           OR summary_lease_until IS NULL
           OR summary_lease_until < now()
         )
       RETURNING id`,
      [noteId, lease],
    );
    if (!claimed.rows[0]) {
      return;
    }
    const beat = setInterval(() => {
      void this.db
        .query(
          `UPDATE notes
           SET summary_lease_until = now() + interval '15 minutes'
           WHERE id = $1 AND summary_lease = $2`,
          [noteId, lease],
        )
        .catch((error: unknown) => {
          this.logger.warn(error instanceof Error ? error.message : 'summary_lease_failed');
        });
    }, 30_000);
    beat.unref?.();
    try {
      await this.db.query(
        `UPDATE notes
         SET transcript_text = $2,
             transcript_turns = $3,
             language = $4,
             transcript_complete = $6,
             updated_at = now()
         WHERE id = $1 AND summary_lease = $5`,
        [noteId, transcript || null, turnsJson, language, lease, complete],
      );
      if (!transcript) {
        await this.db.query(
          `UPDATE notes
           SET status = 'ready',
               summary_text = NULL,
               summary_running = false,
               summary_lease = NULL,
               summary_lease_until = NULL,
               updated_at = now()
           WHERE id = $1 AND summary_lease = $2`,
          [noteId, lease],
        );
        return;
      }
      const summary = await this.summary.summarize(transcript, language);
      await this.db.query(
        `UPDATE notes
         SET status = 'ready',
             summary_text = $2,
             summary_running = false,
             summary_lease = NULL,
             summary_lease_until = NULL,
             error_code = NULL,
             error_message = NULL,
             updated_at = now()
         WHERE id = $1 AND summary_lease = $3`,
        [noteId, summary.bullets.join('\n'), lease],
      );
    } catch (error) {
      await this.db.query(
        `UPDATE notes
         SET status = 'failed',
             error_code = 'gpt',
             error_message = $2,
             summary_running = false,
             summary_lease = NULL,
             summary_lease_until = NULL,
             updated_at = now()
         WHERE id = $1 AND summary_lease = $3`,
        [noteId, safeErrorMessage(error, 'summary_failed'), lease],
      );
    } finally {
      clearInterval(beat);
    }
  }

  private async finishFailed(
    noteId: string,
    slices: { transcript: string | null; source: SliceSource; start_sec: number; end_sec: number; status: string }[],
    typedNotes: string | null,
  ): Promise<void> {
    const turns = slices
      .filter((slice) => slice.status === 'done' && (slice.transcript ?? '').trim())
      .map((slice) => ({
        source: slice.source,
        startSec: slice.start_sec,
        endSec: slice.end_sec,
        text: (slice.transcript ?? '').trim(),
      }));
    const spoken = turns.map((turn) => turn.text).join('\n\n');
    const transcript = [typedNotes?.trim() ?? '', spoken].filter((part) => part.length > 0).join('\n\n');
    await this.db.query(
      `UPDATE notes
       SET status = 'failed',
           error_code = 'stt',
           error_message = 'slice_failed',
           transcript_text = $2,
           transcript_turns = $3,
           transcript_complete = false,
           summary_running = false,
           summary_lease = NULL,
           summary_lease_until = NULL,
           updated_at = now()
       WHERE id = $1 AND status = 'processing'`,
      [noteId, transcript || null, turns.length > 0 ? JSON.stringify(turns) : null],
    );
  }

  private async recoverStale(): Promise<void> {
    await this.db.query(
      `UPDATE note_slices
       SET status = 'queued', locked_at = NULL
       WHERE status = 'running' AND locked_at < now() - interval '15 minutes'`,
    );
    await this.db.query(
      `UPDATE notes
       SET summary_running = false,
           summary_lease = NULL,
           summary_lease_until = NULL,
           updated_at = now()
       WHERE summary_running = true
         AND status = 'processing'
         AND (summary_lease_until IS NULL OR summary_lease_until < now())`,
    );
  }

  /** A sealed note with holes cannot wait forever. The client can retry from saved text. */
  private async expireMissingSlices(): Promise<void> {
    await this.db.query(
      `UPDATE notes
       SET status = 'failed',
           error_code = 'upload',
           error_message = 'slices_missing',
           transcript_complete = false,
           summary_running = false,
           summary_lease = NULL,
           summary_lease_until = NULL,
           updated_at = now()
       WHERE status = 'processing'
         AND summary_from_transcript = false
         AND summary_running = false
         AND final_seq IS NOT NULL
         AND final_seq > 0
         AND updated_at < now() - interval '30 minutes'
         AND NOT EXISTS (
           SELECT 1 FROM note_slices s
           WHERE s.note_id = notes.id AND s.status IN ('queued', 'running')
         )
         AND (
           SELECT count(*) FROM note_slices s
           WHERE s.note_id = notes.id AND s.seq <= notes.final_seq
         ) < notes.final_seq`,
    );
  }

  private async resumeSummaries(): Promise<void> {
    const available = this.summaryConcurrency - this.summarizing.size;
    if (available <= 0) {
      return;
    }
    const notes = await this.db.query<{ id: string }>(
      `SELECT n.id FROM notes n
       WHERE n.status = 'processing' AND n.summary_running = false
         AND NOT (n.id = ANY($1::uuid[]))
         AND (n.summary_from_transcript = true OR (
           n.final_seq IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM note_slices s
             WHERE s.note_id = n.id AND s.seq <= n.final_seq AND s.status IN ('queued', 'running')
           )
           AND (EXISTS (
             SELECT 1 FROM note_slices s WHERE s.note_id = n.id AND s.status = 'failed'
           ) OR (SELECT count(*) FROM note_slices s
                 WHERE s.note_id = n.id AND s.seq <= n.final_seq) = n.final_seq)
         ))
       ORDER BY n.updated_at
       LIMIT $2`,
      [[...this.summarizing], available],
    );
    for (const note of notes.rows) {
      if (this.summarizing.has(note.id) || this.summarizing.size >= this.summaryConcurrency) {
        continue;
      }
      this.summarizing.add(note.id);
      // Do not await provider work inside the scheduler or a request handler.
      void this.maybeSummarize(note.id)
        .catch((error: unknown) => {
          this.logger.warn(error instanceof Error ? error.message : 'summary_failed');
        })
        .finally(() => {
          this.summarizing.delete(note.id);
        });
    }
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
    const configured = process.env.SLICE_DIR?.trim();
    const dir = configured || path.join(process.cwd(), 'data', 'slices');
    await mkdir(dir, { recursive: true });
    return dir;
  }
}
