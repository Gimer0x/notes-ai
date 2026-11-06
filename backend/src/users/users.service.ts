import { Injectable } from '@nestjs/common';
import { freeQuotaWindow } from '../billing/billing.service';
import { DbService } from '../db/db.service';
import type { GoogleIdentity, UserRow } from './user.types';

const USER_RETURNING = `
         id,
         google_subject,
         email,
         display_name,
         avatar_url,
         plan_code,
         created_at,
         stripe_customer_id,
         stripe_price_id,
         subscription_period_start,
         subscription_period_end,
         subscription_paused`;

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService) {}

  async upsertFromGoogle(identity: GoogleIdentity): Promise<UserRow> {
    const prior = await this.db.query<{ id: string }>(
      `SELECT id FROM users WHERE google_subject = $1`,
      [identity.subject],
    );
    const result = await this.db.query<UserRow>(
      `INSERT INTO users (google_subject, email, display_name, avatar_url, plan_code)
       VALUES ($1, $2, $3, $4, 'free')
       ON CONFLICT (google_subject) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name,
         avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
         updated_at = now()
       RETURNING ${USER_RETURNING}`,
      [identity.subject, identity.email, identity.displayName, identity.picture],
    );
    const user = result.rows[0];
    if (!user) {
      throw new Error('failed to upsert user');
    }
    if (!prior.rows[0] && (await this.freeTimeAlreadyUsed(identity.email, identity.subject))) {
      await this.markFreeTimeUsed(user);
    }
    return user;
  }

  async findById(id: string): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>(
      `SELECT ${USER_RETURNING}
       FROM users
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async deleteAccount(userId: string): Promise<void> {
    await this.db.transaction(async (query) => {
      const existing = await query<{ email: string; google_subject: string }>(
        `SELECT email, google_subject FROM users WHERE id = $1`,
        [userId],
      );
      const user = existing.rows[0];
      if (!user) {
        throw new Error('user not found');
      }
      await query(
        `DELETE FROM former_accounts
         WHERE google_subject = $1 AND lower(email) <> lower($2)`,
        [user.google_subject, user.email],
      );
      await query(
        `INSERT INTO former_accounts (email, google_subject)
         VALUES (lower($1), $2)
         ON CONFLICT (email) DO UPDATE SET google_subject = EXCLUDED.google_subject`,
        [user.email, user.google_subject],
      );
      await query(`DELETE FROM note_slices WHERE user_id = $1`, [userId]);
      await query(`DELETE FROM notes WHERE user_id = $1`, [userId]);
      await query(`DELETE FROM workspaces WHERE user_id = $1`, [userId]);
      await query(`DELETE FROM usage_windows WHERE user_id = $1`, [userId]);
      const removed = await query(`DELETE FROM users WHERE id = $1`, [userId]);
      if (removed.rowCount === 0) {
        throw new Error('user not found');
      }
    });
  }

  async subscriptionId(userId: string): Promise<string | null> {
    const result = await this.db.query<{ stripe_subscription_id: string | null }>(
      `SELECT stripe_subscription_id FROM users WHERE id = $1`,
      [userId],
    );
    return result.rows[0]?.stripe_subscription_id ?? null;
  }

  async findByStripeCustomerId(customerId: string): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>(
      `SELECT ${USER_RETURNING}
       FROM users
       WHERE stripe_customer_id = $1`,
      [customerId],
    );
    return result.rows[0] ?? null;
  }

  private async freeTimeAlreadyUsed(email: string, subject: string): Promise<boolean> {
    const found = await this.db.query(
      `SELECT 1 FROM former_accounts
       WHERE lower(email) = lower($1) OR google_subject = $2
       LIMIT 1`,
      [email, subject],
    );
    return Boolean(found.rows[0]);
  }

  private async markFreeTimeUsed(user: UserRow): Promise<void> {
    const plan = await this.db.query<{
      max_listening_seconds_per_window: number;
      max_notes_per_window: number | null;
    }>(
      `SELECT max_listening_seconds_per_window, max_notes_per_window
       FROM plans WHERE code = 'free'`,
    );
    const limits = plan.rows[0];
    if (!limits) {
      return;
    }
    const window = freeQuotaWindow(user.created_at);
    const notes = limits.max_notes_per_window ?? 0;
    await this.db.query(
      `INSERT INTO usage_windows (
         user_id, period_start, period_end, listening_seconds_used, notes_counted
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, period_start) DO UPDATE SET
         listening_seconds_used = GREATEST(usage_windows.listening_seconds_used, EXCLUDED.listening_seconds_used),
         notes_counted = GREATEST(usage_windows.notes_counted, EXCLUDED.notes_counted)`,
      [
        user.id,
        window.start.toISOString(),
        window.end.toISOString(),
        limits.max_listening_seconds_per_window,
        notes,
      ],
    );
  }
}
