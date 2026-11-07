import { unlink } from 'node:fs/promises';
import path from 'node:path';
import type { DbService } from '../db/db.service';

type Query = DbService['query'];

export function sliceRoot(): string {
  const configured = process.env.SLICE_DIR?.trim();
  return path.resolve(configured || path.join(process.cwd(), 'data', 'slices'));
}

export function wavPathOwned(file: string): boolean {
  const root = sliceRoot();
  const resolved = path.resolve(file);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`);
}

export async function queueWavCleanup(query: Query, userId: string, noteId?: string): Promise<void> {
  if (noteId) {
    await query(
      `INSERT INTO wav_cleanup (wav_path)
       SELECT wav_path FROM note_slices
       WHERE note_id = $1 AND user_id = $2 AND wav_path IS NOT NULL`,
      [noteId, userId],
    );
    return;
  }
  await query(
    `INSERT INTO wav_cleanup (wav_path)
     SELECT wav_path FROM note_slices
     WHERE user_id = $1 AND wav_path IS NOT NULL`,
    [userId],
  );
}

export async function drainWavCleanup(query: Query): Promise<void> {
  const pending = await query<{ id: string; wav_path: string }>(
    `SELECT id, wav_path FROM wav_cleanup ORDER BY created_at LIMIT 100`,
  );
  for (const row of pending.rows) {
    if (!wavPathOwned(row.wav_path)) {
      await query(`DELETE FROM wav_cleanup WHERE id = $1`, [row.id]);
      continue;
    }
    try {
      await unlink(path.resolve(row.wav_path));
      await query(`DELETE FROM wav_cleanup WHERE id = $1`, [row.id]);
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      if (missing) {
        await query(`DELETE FROM wav_cleanup WHERE id = $1`, [row.id]);
        continue;
      }
      await query(`UPDATE wav_cleanup SET attempts = attempts + 1 WHERE id = $1`, [row.id]);
    }
  }
}
