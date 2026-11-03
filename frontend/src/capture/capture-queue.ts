import { randomUUID } from 'crypto';
import { copyFile, mkdir, readFile, rename, rm, unlink, writeFile } from 'fs/promises';
import { rmSync, unlinkSync } from 'fs';
import * as path from 'path';
import { captureFiles, manifestExpired, type CaptureFiles, type PreparedBatch, type QueuedPiece } from './upload-queue';

type StoredPiece = Omit<QueuedPiece, 'wav'> & { filePath: string };
type StoredBatch = {
  files: string[];
  durationSeconds: number;
  pieces: StoredPiece[];
  uploaded: number;
};
type Manifest = {
  version: 2;
  noteId: string;
  savedAt: number;
  expiresAt: number;
  retryWindowSeconds: number;
  nextSliceSeq: number;
  audioOffsetSec: number;
  typedNotes: string;
  waiting: CaptureFiles[];
  pending: StoredBatch | null;
};
type Options = {
  root: () => string;
  prepare: (capture: CaptureFiles, nextSeq: number, offsetSec: number) => Promise<PreparedBatch | null>;
  upload: (noteId: string, piece: QueuedPiece) => Promise<void>;
  now?: () => number;
};

/** One on-disk recording, serialized with its uploads and explicit discard operations. */
export class CaptureQueue {
  private state: Manifest | null = null;
  private operations: Promise<unknown> = Promise.resolve();
  private closing = false;
  private unstaged: CaptureFiles[] = [];

  constructor(private readonly options: Options) {}

  get noteId(): string | null { return this.state?.noteId ?? null; }
  get nextSliceSeq(): number { return this.state?.nextSliceSeq ?? 1; }
  get durationSeconds(): number { return this.state?.audioOffsetSec ?? 0; }
  get typedNotes(): string { return this.state?.typedNotes ?? ''; }
  get hasAudio(): boolean { return this.unstaged.length > 0 || Boolean(this.state?.pending || this.state?.waiting.length); }

  arm(noteId: string, retryWindowSeconds: number): Promise<void> {
    return this.serial(async () => {
      await this.remove();
      await this.save({
        version: 2, noteId, savedAt: 0, expiresAt: 0,
        retryWindowSeconds: Number.isFinite(retryWindowSeconds) ? Math.max(0, retryWindowSeconds) : 600,
        nextSliceSeq: 1, audioOffsetSec: 0, typedNotes: '', waiting: [], pending: null,
      });
    });
  }

  setTypedNotes(noteId: string, typedNotes: string): Promise<void> {
    return this.serial(() => this.save({ ...this.owned(noteId), typedNotes }));
  }

  enqueue(noteId: string, captured: CaptureFiles): Promise<void> {
    return this.serial(async () => {
      this.owned(noteId);
      // Retain the helper paths in memory if copying/checkpointing fails. Both
      // live exports and stopped tails can retry without capturing audio again.
      this.unstaged.push(captured);
      await this.stagePending(noteId);
    });
  }

  private async stagePending(noteId: string): Promise<void> {
    while (this.unstaged.length > 0) {
      const state = this.owned(noteId);
      const captured = this.unstaged[0];
      const dir = path.join(this.options.root(), randomUUID());
      await mkdir(dir, { recursive: true });
      const staged: CaptureFiles = { durationSeconds: captured.durationSeconds, filePath: path.join(dir, 'mix.wav') };
      await copyFile(captured.filePath, staged.filePath);
      if (captured.micFilePath) {
        staged.micFilePath = path.join(dir, 'mic.wav');
        await copyFile(captured.micFilePath, staged.micFilePath);
      }
      if (captured.systemFilePath) {
        staged.systemFilePath = path.join(dir, 'system.wav');
        await copyFile(captured.systemFilePath, staged.systemFilePath);
      }
      // Commit the copy before removing the native helper's files.
      await this.save({ ...state, waiting: [...state.waiting, staged] });
      this.unstaged.shift();
      await this.deleteFiles(captureFiles(captured));
    }
  }

  drain(noteId: string): Promise<void> {
    return this.serial(async () => {
      await this.stagePending(noteId);
      while (true) {
        let state = this.owned(noteId);
        if (!state.pending) {
          const captured = state.waiting[0];
          if (!captured) return;
          const prepared = await this.options.prepare(captured, state.nextSliceSeq, state.audioOffsetSec);
          if (!prepared) {
            await this.save({ ...state, waiting: state.waiting.slice(1) });
            await this.deleteFiles(captureFiles(captured));
            continue;
          }
          const dir = path.join(this.options.root(), randomUUID());
          await mkdir(dir, { recursive: true });
          const pieces: StoredPiece[] = [];
          for (const { wav, ...piece } of prepared.pieces) {
            const filePath = path.join(dir, `${piece.seq}.wav`);
            await writeFile(filePath, wav);
            pieces.push({ ...piece, filePath });
          }
          // Persist exact bytes, sequence numbers and boundaries before the first send.
          // Recovery does not re-segment a partly accepted batch with a new config.
          await this.save({ ...state, waiting: state.waiting.slice(1), pending: { ...prepared, pieces } });
          state = this.owned(noteId);
        }
        const batch = state.pending!;
        const piece = batch.pieces[batch.uploaded];
        if (piece) {
          const { filePath, ...metadata } = piece;
          await this.options.upload(noteId, { ...metadata, wav: await readFile(filePath) });
          // If the process crashes before this commit, the same bytes/seq are resent safely.
          await this.save({ ...state, nextSliceSeq: piece.seq + 1, pending: { ...batch, uploaded: batch.uploaded + 1 } });
          continue;
        }
        // Remove all references BEFORE unlinking. A crash can leave harmless files,
        // but never a manifest pointing to acknowledged audio that was deleted.
        await this.save({ ...state, audioOffsetSec: state.audioOffsetSec + batch.durationSeconds, pending: null });
        await this.deleteFiles([...batch.files, ...batch.pieces.map((item) => item.filePath)]);
      }
    });
  }

  clear(noteId?: string): Promise<void> {
    return this.serial(async () => {
      if (noteId && this.state?.noteId !== noteId) return;
      await this.remove();
    });
  }

  restore(): Promise<void> {
    return this.serial(async () => {
      let raw: any;
      try {
        raw = JSON.parse(await readFile(path.join(this.options.root(), 'manifest.json'), 'utf8'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        if (error instanceof SyntaxError) { await this.remove(); return; }
        throw error;
      }
      const now = this.now();
      if (raw?.version !== 2) {
        // Older builds did not store an expiry. Fail closed after the default window,
        // including when config cannot be fetched during launch.
        if (!raw?.noteId || !Array.isArray(raw.waiting) || manifestExpired(raw.savedAt, now, 600)) {
          await this.remove(); return;
        }
        raw = { ...raw, version: 2, expiresAt: raw.savedAt + 600_000,
          retryWindowSeconds: 600, typedNotes: '', pending: null };
      }
      if (!this.validManifest(raw) || now >= raw.expiresAt) {
        await this.remove(); return;
      }
      this.state = raw as Manifest;
    });
  }

  /** Electron must delete unsent audio before actually exiting, without an async race. */
  discardOnQuit(): void {
    this.closing = true;
    this.state = null;
    rmSync(this.options.root(), { recursive: true, force: true });
    for (const file of this.unstaged.flatMap(captureFiles)) {
      try { unlinkSync(file); } catch { /* Already removed. */ }
    }
    this.unstaged = [];
  }

  private validManifest(value: unknown): value is Manifest {
    if (!value || typeof value !== 'object') return false;
    const state = value as Partial<Manifest>;
    const nonNegative = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
    const sequence = (n: unknown): n is number => nonNegative(n) && Number.isInteger(n) && n >= 1;
    const root = path.resolve(this.options.root()) + path.sep;
    const localFile = (file: unknown): file is string => typeof file === 'string' && path.resolve(file).startsWith(root);
    if (state.version !== 2 || typeof state.noteId !== 'string' || !state.noteId ||
        !nonNegative(state.savedAt) || !nonNegative(state.expiresAt) ||
        !nonNegative(state.retryWindowSeconds) || !nonNegative(state.audioOffsetSec) ||
        !sequence(state.nextSliceSeq) || typeof state.typedNotes !== 'string' || !Array.isArray(state.waiting)) return false;
    for (const capture of state.waiting) {
      if (!capture || !nonNegative(capture.durationSeconds) || !localFile(capture.filePath) ||
          (capture.micFilePath !== undefined && !localFile(capture.micFilePath)) ||
          (capture.systemFilePath !== undefined && !localFile(capture.systemFilePath))) return false;
    }
    if (state.pending !== null) {
      const batch = state.pending;
      if (!batch || !Array.isArray(batch.files) || !batch.files.every(localFile) ||
          !nonNegative(batch.durationSeconds) || !Array.isArray(batch.pieces) ||
          !nonNegative(batch.uploaded) || !Number.isInteger(batch.uploaded) || batch.uploaded > batch.pieces.length) return false;
      for (const piece of batch.pieces) {
        if (!piece || !sequence(piece.seq) || !localFile(piece.filePath) ||
            !['mic', 'system', 'mix'].includes(piece.source) || !nonNegative(piece.startSec) ||
            !nonNegative(piece.endSec) || piece.endSec < piece.startSec) return false;
      }
    }
    return true;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const result = this.operations.then(() => {
      if (this.closing) throw new Error('capture_closed');
      return run();
    });
    this.operations = result.catch(() => undefined);
    return result;
  }

  private owned(noteId: string): Manifest {
    if (this.closing || this.state?.noteId !== noteId) throw new Error('capture_changed');
    return this.state;
  }

  private now(): number { return this.options.now?.() ?? Date.now(); }

  private async save(state: Manifest): Promise<void> {
    if (this.closing) throw new Error('capture_closed');
    const savedAt = this.now();
    const next = { ...state, savedAt, expiresAt: savedAt + state.retryWindowSeconds * 1000 };
    const root = this.options.root();
    await mkdir(root, { recursive: true });
    const temp = path.join(root, 'manifest.tmp');
    await writeFile(temp, JSON.stringify(next));
    await rename(temp, path.join(root, 'manifest.json'));
    this.state = next;
  }

  private async remove(): Promise<void> {
    await rm(this.options.root(), { recursive: true, force: true });
    await this.deleteFiles(this.unstaged.flatMap(captureFiles));
    this.unstaged = [];
    this.state = null;
  }

  private async deleteFiles(files: string[]): Promise<void> {
    await Promise.all(files.map((file) => unlink(file).catch(() => undefined)));
  }
}
