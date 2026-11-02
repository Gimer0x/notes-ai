export type CaptureFiles = {
  filePath: string;
  micFilePath?: string;
  systemFilePath?: string;
  durationSeconds: number;
};

export type TrackPiece = {
  source: 'mic' | 'system' | 'mix';
  startSec: number;
  endSec: number;
  wav: Buffer;
};

export type QueuedPiece = TrackPiece & { seq: number };

export type PreparedBatch = {
  files: string[];
  durationSeconds: number;
  pieces: QueuedPiece[];
  uploaded: number;
};

export function captureFiles(captured: CaptureFiles): string[] {
  return [captured.filePath, captured.micFilePath, captured.systemFilePath].filter(
    (file): file is string => typeof file === 'string' && file.length > 0,
  );
}

/** Assign sequence numbers once. A retry keeps those numbers until each piece is acknowledged. */
export function prepareBatch(
  nextSeq: number,
  offsetSec: number,
  durationSeconds: number,
  files: string[],
  pieces: TrackPiece[],
): PreparedBatch {
  return {
    files,
    durationSeconds,
    uploaded: 0,
    pieces: pieces.map((piece, index) => ({
      source: piece.source,
      startSec: offsetSec + piece.startSec,
      endSec: offsetSec + piece.endSec,
      wav: piece.wav,
      seq: nextSeq + index,
    })),
  };
}

export function currentPiece(batch: PreparedBatch): QueuedPiece | null {
  return batch.pieces[batch.uploaded] ?? null;
}

/** Returns the next sequence to allocate after this acknowledgement. */
export function markPieceUploaded(batch: PreparedBatch): number {
  const piece = batch.pieces[batch.uploaded];
  if (!piece) {
    return batch.pieces.length === 0 ? 1 : batch.pieces[batch.pieces.length - 1].seq + 1;
  }
  batch.uploaded += 1;
  return piece.seq + 1;
}

export function batchDone(batch: PreparedBatch): boolean {
  return batch.uploaded >= batch.pieces.length;
}

export type QueueManifest = {
  noteId: string;
  savedAt: number;
  nextSliceSeq: number;
  audioOffsetSec: number;
  waiting: CaptureFiles[];
};

/** Unsent audio is kept only for the server's upload retry window, and never after quit. */
export function manifestExpired(savedAt: number, now: number, windowSeconds: number): boolean {
  return windowSeconds > 0 && now - savedAt > windowSeconds * 1000;
}
