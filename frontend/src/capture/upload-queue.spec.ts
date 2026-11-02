import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  batchDone,
  captureFiles,
  currentPiece,
  markPieceUploaded,
  prepareBatch,
  type TrackPiece,
} from './upload-queue';

function piece(start: number, end: number): TrackPiece {
  return { source: 'mix', startSec: start, endSec: end, wav: Buffer.from('wav') };
}

describe('upload queue', () => {
  it('keeps the same sequence when an upload is not acknowledged', () => {
    const batch = prepareBatch(1, 300, 300, ['/tmp/mix.wav'], [piece(0, 120), piece(120, 300)]);
    const first = currentPiece(batch);
    assert.equal(first?.seq, 1);
    assert.equal(batchDone(batch), false);
    assert.deepEqual(batch.files, ['/tmp/mix.wav']);
    const next = markPieceUploaded(batch);
    assert.equal(next, 2);
    assert.equal(currentPiece(batch)?.seq, 2);
    assert.equal(batchDone(batch), false);
    markPieceUploaded(batch);
    assert.equal(batchDone(batch), true);
  });

  it('does not overlap the next batch with an unacknowledged piece', () => {
    const first = prepareBatch(1, 0, 300, ['/tmp/a.wav'], [piece(0, 300)]);
    const allocated = markPieceUploaded(first);
    const second = prepareBatch(allocated, 300, 300, ['/tmp/b.wav'], [piece(0, 300)]);
    assert.equal(currentPiece(second)?.seq, 2);
    assert.equal(currentPiece(second)?.startSec, 300);
  });

  it('lists every capture file that must stay until the batch finishes', () => {
    assert.deepEqual(
      captureFiles({
        filePath: '/tmp/mix.wav',
        micFilePath: '/tmp/mic.wav',
        systemFilePath: '',
        durationSeconds: 10,
      }),
      ['/tmp/mix.wav', '/tmp/mic.wav'],
    );
  });
});
