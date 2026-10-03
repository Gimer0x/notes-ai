import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DbService } from '../db/db.service';
import { toWorkspace, type WorkspaceResponse, type WorkspaceRow } from './note.types';

const DEFAULT_WORKSPACE_NAME = 'Personal';
const NAME_MAX = 120;

@Injectable()
export class WorkspacesService {
  constructor(private readonly db: DbService) {}

  async list(userId: string): Promise<WorkspaceResponse[]> {
    await this.ensureDefault(userId);
    const result = await this.db.query<WorkspaceRow>(
      `SELECT id, name, created_at, updated_at
       FROM workspaces
       WHERE user_id = $1
       ORDER BY created_at ASC`,
      [userId],
    );
    return result.rows.map(toWorkspace);
  }

  async create(userId: string, name: string): Promise<WorkspaceResponse> {
    const trimmed = cleanName(name);
    const result = await this.db.query<WorkspaceRow>(
      `INSERT INTO workspaces (user_id, name)
       VALUES ($1, $2)
       RETURNING id, name, created_at, updated_at`,
      [userId, trimmed],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('workspace insert failed');
    }
    return toWorkspace(row);
  }

  async remove(userId: string, workspaceId: string): Promise<void> {
    await this.db.transaction(async (query) => {
      const owned = await query<WorkspaceRow>(
        `SELECT id, name, created_at, updated_at
         FROM workspaces
         WHERE id = $1 AND user_id = $2
         FOR UPDATE`,
        [workspaceId, userId],
      );
      if (!owned.rows[0]) {
        throw new NotFoundException('workspace_not_found');
      }
      const count = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM workspaces WHERE user_id = $1`,
        [userId],
      );
      if (Number(count.rows[0]?.count ?? 0) <= 1) {
        throw new ConflictException('last_workspace');
      }
      const notes = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM notes WHERE workspace_id = $1`,
        [workspaceId],
      );
      if (Number(notes.rows[0]?.count ?? 0) > 0) {
        throw new ConflictException('workspace_not_empty');
      }
      await query(`DELETE FROM workspaces WHERE id = $1 AND user_id = $2`, [
        workspaceId,
        userId,
      ]);
    });
  }

  async assertOwned(userId: string, workspaceId: string): Promise<void> {
    const result = await this.db.query<{ id: string }>(
      `SELECT id FROM workspaces WHERE id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    if (!result.rows[0]) {
      throw new NotFoundException('workspace_not_found');
    }
  }

  private async ensureDefault(userId: string): Promise<void> {
    await this.db.transaction(async (query) => {
      await query(`SELECT pg_advisory_xact_lock(hashtext($1)::bigint)`, [userId]);
      const existing = await query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM workspaces WHERE user_id = $1`,
        [userId],
      );
      if (Number(existing.rows[0]?.count ?? 0) > 0) {
        return;
      }
      await query(
        `INSERT INTO workspaces (user_id, name) VALUES ($1, $2)`,
        [userId, DEFAULT_WORKSPACE_NAME],
      );
    });
  }
}

function cleanName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > NAME_MAX) {
    throw new BadRequestException('workspace_name');
  }
  return trimmed;
}
