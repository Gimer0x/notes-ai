import { BadRequestException } from '@nestjs/common';
import type { NoteRow } from './note.types';
import { NotesService } from './notes.service';

const USER = '11111111-1111-4111-8111-111111111111';
const NOTE = '22222222-2222-4222-8222-222222222222';

function failedNote(errorCode: 'stt' | 'gpt'): NoteRow {
  return {
    id: NOTE,
    workspace_id: USER,
    title: null,
    status: 'failed',
    summary_text: null,
    transcript_text: 'We discussed the vacation request.',
    transcript_turns: null,
    language: 'en',
    error_code: errorCode,
    error_message: 'slice_failed',
    transcript_complete: errorCode === 'gpt',
    started_at: new Date('2026-11-02T18:00:00Z'),
    ended_at: new Date('2026-11-02T18:05:00Z'),
    duration_seconds: 300,
    created_at: new Date('2026-11-02T18:00:00Z'),
    updated_at: new Date('2026-11-02T18:05:00Z'),
  };
}

describe('note retry', () => {
  it('requeues failed audio instead of summarizing a partial transcript', async () => {
    const slices = { requeueFailedAudio: jest.fn(async () => true) };
    const summary = { summarize: jest.fn() };
    const db = { query: jest.fn(async () => ({ rows: [failedNote('stt')] })), transaction: jest.fn() };
    const notes = new NotesService(db as never, {} as never, {} as never, summary as never, slices as never);
    const result = await notes.retry(USER, NOTE);
    expect(slices.requeueFailedAudio).toHaveBeenCalledWith(USER, NOTE);
    expect(summary.summarize).not.toHaveBeenCalled();
    expect(result.errorCode).toBe('stt');
  });

  it('queues a saved transcript and returns before any summary provider call', async () => {
    const slices = { requeueFailedAudio: jest.fn(), queueSummaryRetry: jest.fn(async () => undefined) };
    const summary = { summarize: jest.fn(async () => ({ bullets: ['# Done', '• Next step'] })) };
    const processing = { ...failedNote('gpt'), status: 'processing' as const, error_code: null };
    let reads = 0;
    const db = {
      query: jest.fn(async (sql: string) => {
        reads += 1;
        return { rows: [reads === 1 ? failedNote('gpt') : processing] };
      }),
      transaction: jest.fn(),
    };
    const notes = new NotesService(db as never, {} as never, {} as never, summary as never, slices as never);
    const result = await notes.retry(USER, NOTE);
    expect(slices.requeueFailedAudio).not.toHaveBeenCalled();
    expect(slices.queueSummaryRetry).toHaveBeenCalledWith(USER, NOTE);
    expect(summary.summarize).not.toHaveBeenCalled();
    expect(result.status).toBe('processing');
  });

  it('rejects a note id that is not a uuid', async () => {
    const notes = new NotesService({} as never, {} as never, {} as never, {} as never, {} as never);
    await expect(notes.retry('not-a-uuid', NOTE)).rejects.toBeInstanceOf(BadRequestException);
  });
});
