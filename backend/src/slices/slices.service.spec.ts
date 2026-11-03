import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { SlicesService } from './slices.service';

const USER = '11111111-1111-4111-8111-111111111111';
const NOTE = '22222222-2222-4222-8222-222222222222';

const written: string[] = [];
const removed: string[] = [];

jest.mock('fs/promises', () => ({
  writeFile: jest.fn(async (file: string) => {
    written.push(String(file));
  }),
  unlink: jest.fn(async (file: string) => {
    removed.push(String(file));
  }),
  mkdir: jest.fn(async () => undefined),
  readFile: jest.fn(),
}));

function service(query: (sql: string) => { rows: unknown[] }): SlicesService {
  const db = {
    query: jest.fn(async (sql: string) => query(sql)),
    transaction: jest.fn(async (run: (query: (sql: string) => Promise<{ rows: unknown[] }>) => Promise<void>) =>
      run(async () => ({ rows: [] })),
    ),
  };
  const billing = { recordListen: jest.fn() };
  return new SlicesService(db as never, billing as never, { summarize: jest.fn() } as never, {} as never);
}

describe('slice acceptance', () => {
  beforeEach(() => {
    written.length = 0;
    removed.length = 0;
  });

  it('returns a running slice without writing or deleting its audio', async () => {
    const slices = service((sql) => {
      if (sql.includes('SELECT status FROM notes')) {
        return { rows: [{ status: 'listening' }] };
      }
      if (sql.includes('wav_path')) {
        return { rows: [{ id: 'slice-1', status: 'running', wav_path: '/tmp/pith-slices/kept.wav' }] };
      }
      return { rows: [] };
    });
    await expect(
      slices.accept({
        userId: USER,
        noteId: NOTE,
        seq: 1,
        source: 'mix',
        startSec: 0,
        endSec: 30,
        wav: Buffer.from('RIFF'),
      }),
    ).resolves.toEqual({ sliceId: 'slice-1' });
    expect(written).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('does not record listening time when seal does not change the note', async () => {
    const billing = { recordListen: jest.fn() };
    const db = {
      query: jest.fn(async () => ({ rows: [] })),
      transaction: jest.fn(
        async (run: (query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>) => Promise<void>) =>
          run(async () => ({ rows: [] })),
      ),
    };
    const slices = new SlicesService(
      db as never,
      billing as never,
      { summarize: jest.fn() } as never,
      {} as never,
    );
    await expect(
      slices.seal({
        userId: USER,
        noteId: NOTE,
        finalSeq: 1,
        durationSeconds: 40,
        typedNotes: '',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(billing.recordListen).not.toHaveBeenCalled();
  });

  it('rejects a different payload for a slice that is already running', async () => {
    const slices = service((sql) => {
      if (sql.includes('SELECT status FROM notes')) {
        return { rows: [{ status: 'listening' }] };
      }
      if (sql.includes('content_sha256')) {
        return { rows: [{ id: 'slice-1', status: 'running', wav_path: '/tmp/kept.wav', content_sha256: 'abc' }] };
      }
      return { rows: [] };
    });
    await expect(
      slices.accept({
        userId: USER,
        noteId: NOTE,
        seq: 1,
        source: 'mix',
        startSec: 0,
        endSec: 30,
        wav: Buffer.from('RIFF'),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(written).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('rejects a slice range that is not a finite ordered span', async () => {
    const slices = service(() => ({ rows: [{ status: 'listening' }] }));
    await expect(
      slices.accept({
        userId: USER,
        noteId: NOTE,
        seq: 1,
        source: 'mix',
        startSec: 10,
        endSec: Number.NaN,
        wav: Buffer.from('RIFF'),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(written).toEqual([]);
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('independent background workers', () => {
  it('keeps claiming transcription while summaries are pending, with a separate summary bound', async () => {
    const summary = deferred<void>();
    const transcriptions = [deferred<void>(), deferred<void>(), deferred<void>()];
    const db = { query: jest.fn(async () => ({ rows: [{ id: NOTE }, { id: USER }, { id: 'third' }] })) };
    const slices = new SlicesService(db as never, {} as never, {} as never, {} as never);
    const worker = slices as any;
    worker.recoverStale = jest.fn();
    worker.purgeFailedAudio = jest.fn();
    worker.expireMissingSlices = jest.fn();
    worker.maybeSummarize = jest.fn(() => summary.promise);
    let claims = 0;
    worker.claim = jest.fn(async () => claims < 3 ? { id: claims++, note_id: NOTE } : null);
    worker.run = jest.fn((job: { id: number }) => transcriptions[job.id].promise);
    await worker.tick();
    expect(worker.maybeSummarize).toHaveBeenCalledTimes(2);
    expect(worker.run).toHaveBeenCalledTimes(2);
    expect(worker.ticking).toBe(false);
    await worker.tick();
    expect(worker.maybeSummarize).toHaveBeenCalledTimes(2);
    transcriptions[0].resolve();
    await flush();
    expect(worker.run).toHaveBeenCalledTimes(3);
    expect(worker.maybeSummarize).toHaveBeenCalledTimes(2);
    summary.resolve();
    transcriptions[1].resolve();
    transcriptions[2].resolve();
    // Let final callbacks settle without dispatching the mock's same notes again.
    worker.tick = jest.fn();
    await flush();
    expect(worker.inFlight).toBe(0);
    expect(worker.summarizing.size).toBe(0);
  });

  it('acknowledges seal and repeated seal without calling the summary provider or billing twice', async () => {
    let status = 'listening';
    const query = jest.fn(async (sql: string) => {
      if (sql.includes('SELECT status, final_seq')) return { rows: [{ status, final_seq: status === 'processing' ? 1 : null }] };
      if (sql.includes('SELECT seq FROM')) return { rows: [{ seq: 1 }] };
      if (sql.includes('UPDATE notes')) { status = 'processing'; return { rows: [{ id: NOTE }] }; }
      throw new Error(`unexpected query: ${sql}`);
    });
    const db = { transaction: async (run: (query: unknown) => unknown) => run(query) };
    const billing = { recordListen: jest.fn() };
    const summary = { summarize: jest.fn(() => new Promise(() => {})) };
    const slices = new SlicesService(db as never, billing as never, summary as never, {} as never);
    const input = { userId: USER, noteId: NOTE, finalSeq: 1, durationSeconds: 300, typedNotes: 'Typed notes' };
    await slices.seal(input);
    await slices.seal(input);
    expect(status).toBe('processing');
    expect(billing.recordListen).toHaveBeenCalledTimes(1);
    expect(summary.summarize).not.toHaveBeenCalled();
    expect(query.mock.calls[0][0]).toContain('FOR UPDATE');
  });

  it('summarizes saved partial text under a lease without losing typed notes or the incomplete flag', async () => {
    const queries: { sql: string; values?: unknown[] }[] = [];
    const db = { query: jest.fn(async (sql: string, values?: unknown[]) => {
      queries.push({ sql, values });
      if (sql.includes('SELECT final_seq')) return { rows: [{
        status: 'processing', summary_running: false, summary_from_transcript: true,
        final_seq: 3, transcript_text: 'Typed decision\n\nSurviving speech',
        transcript_turns: null, transcript_complete: false, language: 'es',
      }] };
      return { rows: [{ id: NOTE }] };
    }) };
    const summary = { summarize: jest.fn(async () => ({ bullets: ['Result'] })) };
    const slices = new SlicesService(db as never, {} as never, summary as never, {} as never);
    await (slices as any).maybeSummarize(NOTE);
    expect(summary.summarize).toHaveBeenCalledWith('Typed decision\n\nSurviving speech', 'es');
    expect(queries.some(({ sql }) => sql.includes('FROM note_slices'))).toBe(false);
    const transcript = queries.find(({ sql }) => sql.includes('SET transcript_text'))!;
    expect(transcript.values?.[5]).toBe(false);
    const claim = queries.find(({ sql }) => sql.includes('SET summary_running = true'))!;
    const finished = queries.find(({ sql }) => sql.includes("SET status = 'ready'"))!;
    expect(finished.sql).toContain('summary_lease = $3');
    expect(finished.values?.[2]).toEqual(claim.values?.[1]);
    expect(finished.sql).not.toContain('transcript_complete = true');
  });

  it('rejects a concurrent summary retry once the note was queued', async () => {
    let failed = true;
    const db = { query: jest.fn(async () => {
      if (!failed) return { rows: [] };
      failed = false;
      return { rows: [{ id: NOTE }] };
    }) };
    const slices = new SlicesService(db as never, {} as never, {} as never, {} as never);
    await slices.queueSummaryRetry(USER, NOTE);
    await expect(slices.queueSummaryRetry(USER, NOTE)).rejects.toBeInstanceOf(ConflictException);
    expect(db.query.mock.calls).toHaveLength(2);
  });
});
