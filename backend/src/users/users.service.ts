import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import type { GoogleIdentity, UserRow } from './user.types';

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService) {}

  async upsertFromGoogle(identity: GoogleIdentity): Promise<UserRow> {
    const result = await this.db.query<UserRow>(
      `INSERT INTO users (google_subject, email, display_name, plan_code)
       VALUES ($1, $2, $3, 'free')
       ON CONFLICT (google_subject) DO UPDATE SET
         email = EXCLUDED.email,
         display_name = EXCLUDED.display_name,
         updated_at = now()
       RETURNING
         id,
         google_subject,
         email,
         display_name,
         plan_code,
         created_at,
         subscription_period_start,
         subscription_period_end`,
      [identity.subject, identity.email, identity.displayName],
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
         plan_code,
         created_at,
         subscription_period_start,
         subscription_period_end
       FROM users
       WHERE id = $1`,
      [id],
    );
    return result.rows[0] ?? null;
  }
}
