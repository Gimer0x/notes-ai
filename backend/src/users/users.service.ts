import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import type { GoogleIdentity, UserRow } from './user.types';

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService) {}

  async upsertFromGoogle(identity: GoogleIdentity): Promise<UserRow> {
    const result = await this.db.query<UserRow>(
      `INSERT INTO users (google_subject, email, display_name, avatar_url, plan_code)
       VALUES ($1, $2, $3, $4, 'free')
       ON CONFLICT (google_subject) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name,
         avatar_url = COALESCE(EXCLUDED.avatar_url, users.avatar_url),
         updated_at = now()
       RETURNING
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
         subscription_period_end`,
      [identity.subject, identity.email, identity.displayName, identity.picture],
    );
    const user = result.rows[0];
    if (!user) {
      throw new Error('failed to upsert user');
    }
    return user;
  }

  async findById(id: string): Promise<UserRow | null> {
    const result = await this.db.query<UserRow>(
      `SELECT
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
         subscription_period_end
       FROM users
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }

  async deleteAccount(userId: string): Promise<void> {
    await this.db.transaction(async (query) => {
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
      `SELECT
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
         subscription_period_end
       FROM users
       WHERE stripe_customer_id = $1`,
      [customerId],
    );
    return result.rows[0] ?? null;
  }
}
