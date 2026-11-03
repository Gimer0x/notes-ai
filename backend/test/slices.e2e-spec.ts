import type { INestApplication } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { DbService } from '../src/db/db.service';
import { NotesService } from '../src/notes/notes.service';
import { SlicesService } from '../src/slices/slices.service';
import { SummaryService } from '../src/summary/summary.service';
import { OpenAiTranscribeService } from '../src/transcribe/openai-transcribe.service';
import { createTestApp, resetDb } from './app';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('durable processing (e2e)', () => {
  let app: INestApplication;
  let dir: string;
  beforeAll(async () => {
    app = await createTestApp();
    dir = await mkdtemp(path.join(tmpdir(), 'pith-worker-test-'));
  });
  beforeEach(async () => { await resetDb(app); });
  afterEach(() => { jest.restoreAllMocks(); });
  afterAll(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  it('processes a 100-user wave with independent bounded workers and no lost notes', async () => {
    const db = app.get(DbService);
    const slices = app.get(SlicesService);
    const worker = slices as any;
    let sttActive = 0, maxStt = 0, summaryActive = 0, maxSummary = 0;
    let transcribed = 0, summarized = 0;
    // Simulated providers exercise the real database queue and file lifecycle.
    jest.spyOn(app.get(OpenAiTranscribeService), 'transcribeBuffers').mockImplementation(async () => {
      maxStt = Math.max(maxStt, ++sttActive);
      await pause(5);
      sttActive--; transcribed++;
      return { transcript: 'Meeting speech', language: 'en' };
    });
    jest.spyOn(app.get(SummaryService), 'summarize').mockImplementation(async () => {
      maxSummary = Math.max(maxSummary, ++summaryActive);
      await pause(15);
      summaryActive--; summarized++;
      return { bullets: ['Summary'] };
    });
    worker.transcriptionConcurrency = 8;
    worker.summaryConcurrency = 2;
    const records = await db.query<{ id: string; user_id: string }>(`
      WITH u AS (
        INSERT INTO users (google_subject, email, plan_code)
        SELECT 'wave-' || i, 'wave-' || i || '@example.com', 'paid' FROM generate_series(1, 100) i
        RETURNING id
      ), w AS (
        INSERT INTO workspaces (user_id, name) SELECT id, 'Wave' FROM u RETURNING id, user_id
      )
      INSERT INTO notes (workspace_id, user_id, status, started_at)
      SELECT id, user_id, 'listening', now() FROM w RETURNING id, user_id
    `);
    // Thirty pieces per recording matches the review's alternating-speaker fixture.
    for (const note of records.rows) {
      for (let seq = 1; seq <= 30; seq++) {
        const file = path.join(dir, `${note.id}-${seq}.wav`);
        await writeFile(file, 'mock audio');
        await db.query(`INSERT INTO note_slices
          (note_id, user_id, seq, status, source, start_sec, end_sec, wav_path)
          VALUES ($1, $2, $3, 'queued', 'mix', $4, $5, $6)`,
          [note.id, note.user_id, seq, (seq - 1) * 10, seq * 10, file]);
      }
      await slices.seal({ userId: note.user_id, noteId: note.id, finalSeq: 30, durationSeconds: 300, typedNotes: 'Typed decision' });
    }
    const deadline = Date.now() + 45_000;
    let remaining = 100;
    while (Date.now() < deadline) {
      await worker.tick();
      const result = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM notes WHERE status <> 'ready'`);
      remaining = Number(result.rows[0].count);
      if (remaining === 0 && worker.inFlight === 0 && worker.summarizing.size === 0) break;
      await pause(10);
    }
    expect(remaining).toBe(0);
    expect(transcribed).toBe(3000);
    expect(summarized).toBe(100);
    expect(maxStt).toBeLessThanOrEqual(8);
    expect(maxStt).toBeGreaterThan(1);
    expect(maxSummary).toBeLessThanOrEqual(2);
    const ledger = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM listen_ledger');
    expect(Number(ledger.rows[0].count)).toBe(100);
    const final = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM notes
      WHERE transcript_complete = true AND transcript_text LIKE 'Typed decision%' AND summary_text = 'Summary'`);
    expect(Number(final.rows[0].count)).toBe(100);
    const audio = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM note_slices WHERE wav_path IS NOT NULL');
    expect(Number(audio.rows[0].count)).toBe(0);
  }, 60_000);

  it('queues a partial-text retry once and preserves incompleteness through the leased worker', async () => {
    const db = app.get(DbService);
    const created = await db.query<{ id: string; user_id: string }>(`
      WITH u AS (INSERT INTO users (google_subject, email) VALUES ('partial', 'partial@example.com') RETURNING id),
      w AS (INSERT INTO workspaces (user_id, name) SELECT id, 'Partial' FROM u RETURNING id, user_id)
      INSERT INTO notes (workspace_id, user_id, status, final_seq, transcript_text, transcript_complete, error_code)
      SELECT id, user_id, 'failed', 3, 'Typed notes and surviving speech', false, 'stt' FROM w RETURNING id, user_id
    `);
    const note = created.rows[0];
    const service = app.get(NotesService);
    const retries = await Promise.allSettled([service.retry(note.user_id, note.id), service.retry(note.user_id, note.id)]);
    expect(retries.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const queued = await service.get(note.user_id, note.id);
    expect(queued.status).toBe('processing');
    expect(queued.transcriptComplete).toBe(false);
    await (app.get(SlicesService) as any).maybeSummarize(note.id);
    const ready = await service.get(note.user_id, note.id);
    expect(ready.status).toBe('ready');
    expect(ready.transcriptComplete).toBe(false);
    expect(ready.transcriptText).toBe('Typed notes and surviving speech');
  });
});
