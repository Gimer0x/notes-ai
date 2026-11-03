import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { mkdtemp, readFile, rm, writeFile, access } from 'fs/promises';
import * as path from 'path';
import { tmpdir } from 'os';
import { CaptureQueue } from './capture-queue';
import { prepareBatch, captureFiles, type QueuedPiece } from './upload-queue';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(upload: (note: string, piece: QueuedPiece) => Promise<void> = async () => {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'pith-queue-test-'));
  dirs.push(dir);
  const root = path.join(dir, 'capture-queue');
  let now = 1_000_000;
  let prepares = 0;
  const options = {
    root: () => root, now: () => now, upload,
    prepare: async (capture: Parameters<typeof captureFiles>[0], seq: number, offset: number) => {
      prepares += 1;
      return prepareBatch(seq, offset, capture.durationSeconds, captureFiles(capture), [
        { source: 'mic' as const, startSec: 0, endSec: 150, wav: Buffer.from('first exact bytes') },
        { source: 'system' as const, startSec: 150, endSec: 300, wav: Buffer.from('second exact bytes') },
      ]);
    },
  };
  const queue = new CaptureQueue(options);
  await queue.arm('note-a', 600);
  const input = path.join(dir, 'original.wav');
  await writeFile(input, 'original audio');
  await queue.enqueue('note-a', { filePath: input, durationSeconds: 300 });
  return { root, queue, restore: () => new CaptureQueue(options),
    now: (value: number) => { now = value; }, prepares: () => prepares,
    manifest: async () => JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8')) };
}

it('checkpoints every acknowledgement and restores exact pieces without re-segmenting', async () => {
  let offline = true;
  const sent: QueuedPiece[] = [];
  const f = await fixture(async (_note, piece) => {
    sent.push(piece);
    if (piece.seq === 2 && offline) throw new Error('offline');
  });
  await assert.rejects(f.queue.drain('note-a'), /offline/);
  const manifest = await f.manifest();
  assert.equal(manifest.pending.uploaded, 1);
  assert.equal(manifest.nextSliceSeq, 2);
  const resumed = f.restore();
  await resumed.restore();
  offline = false;
  await resumed.drain('note-a');
  assert.deepEqual(sent.map((piece) => piece.seq), [1, 2, 2]);
  assert.deepEqual(sent[1], sent[2]);
  assert.equal(f.prepares(), 1);
  assert.equal(resumed.durationSeconds, 300);
  assert.equal(resumed.nextSliceSeq, 3);
  assert.equal(resumed.hasAudio, false);
  const saved = await f.manifest();
  assert.equal(saved.pending, null);
  assert.deepEqual(saved.waiting, []);
  for (const piece of manifest.pending.pieces) await assert.rejects(access(piece.filePath));
  const afterCrash = f.restore();
  await afterCrash.restore();
  await afterCrash.drain('note-a');
  assert.equal(afterCrash.noteId, 'note-a'); // It can still seal the fully uploaded recording.
  assert.equal(afterCrash.durationSeconds, 300);
});

it('resends the same sequence and bytes after an acceptance with a lost response', async () => {
  let loseResponse = true;
  const accepted = new Map<number, string>();
  const f = await fixture(async (_note, piece) => {
    const bytes = piece.wav.toString('base64');
    if (accepted.has(piece.seq)) assert.equal(accepted.get(piece.seq), bytes);
    accepted.set(piece.seq, bytes);
    if (loseResponse) throw new Error('timeout after acceptance');
  });
  await assert.rejects(f.queue.drain('note-a'));
  const resumed = f.restore();
  await resumed.restore();
  loseResponse = false;
  await resumed.drain('note-a');
  assert.equal(accepted.size, 2);
  assert.equal(resumed.durationSeconds, 300);
});

it('persists typed notes and the retry deadline without a config request on launch', async () => {
  const f = await fixture();
  await f.queue.setTypedNotes('note-a', 'Decision from my typed notes');
  f.now(1_599_999);
  const resumed = f.restore();
  await resumed.restore();
  assert.equal(resumed.typedNotes, 'Decision from my typed notes');
  f.now(1_600_000);
  const expired = f.restore();
  await expired.restore();
  assert.equal(expired.noteId, null);
  await assert.rejects(access(f.root));
});

it('serializes discard behind an in-flight upload and does not delete the next recording', async () => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const entered = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(async () => { started(); await gate; });
  const draining = f.queue.drain('note-a');
  await entered;
  const clearing = f.queue.clear('note-a');
  const arming = f.queue.arm('note-b', 600);
  release();
  await Promise.all([draining, clearing, arming]);
  await f.queue.clear('note-a');
  assert.equal(f.queue.noteId, 'note-b');
  assert.equal((await f.manifest()).noteId, 'note-b');
});

it('deletes retained audio synchronously when quitting', async () => {
  const f = await fixture();
  f.queue.discardOnQuit();
  await assert.rejects(access(f.root));
  await assert.rejects(f.queue.drain('note-a'), /capture_closed/);
});

it('expires legacy manifests rather than retaining audio indefinitely when offline', async () => {
  const f = await fixture();
  const current = await f.manifest();
  const legacy = { noteId: current.noteId, savedAt: current.savedAt,
    nextSliceSeq: 1, audioOffsetSec: 0, waiting: current.waiting };
  await writeFile(path.join(f.root, 'manifest.json'), JSON.stringify(legacy));
  f.now(1_700_000);
  const resumed = f.restore();
  await resumed.restore();
  assert.equal(resumed.noteId, null);
  await assert.rejects(access(f.root));
});

it('discards a malformed manifest without preventing the app from launching', async () => {
  const f = await fixture();
  const manifest = await f.manifest();
  manifest.waiting = [null];
  await writeFile(path.join(f.root, 'manifest.json'), JSON.stringify(manifest));
  const resumed = f.restore();
  await resumed.restore();
  assert.equal(resumed.noteId, null);
  await assert.rejects(access(f.root));
});
