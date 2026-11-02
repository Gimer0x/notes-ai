import { BadRequestException } from '@nestjs/common';
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
    await slices.seal({
      userId: USER,
      noteId: NOTE,
      finalSeq: 1,
      durationSeconds: 40,
      typedNotes: '',
    });
    expect(billing.recordListen).not.toHaveBeenCalled();
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
