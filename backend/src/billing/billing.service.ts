import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import type { UserRow } from '../users/user.types';

export type BillingStatus = {
  plan: 'free' | 'paid';
  remainingSeconds: number;
  remainingNotes: number | null;
};

type PlanRow = {
  code: 'free' | 'paid';
  max_listening_seconds_per_window: number;
  max_notes_per_window: number | null;
};

type WindowRow = {
  listening_seconds_used: number;
  notes_counted: number;
};

/** Free quota window from PLAN: 30 days from signup, not a calendar month. */
const FREE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

@Injectable()
export class BillingService {
  constructor(private readonly db: DbService) {}

  async getStatus(userId: string): Promise<BillingStatus> {
    const userResult = await this.db.query<UserRow>(
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
      [userId],
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new Error('user not found');
    }
    const planResult = await this.db.query<PlanRow>(
      `SELECT code, max_listening_seconds_per_window, max_notes_per_window
       FROM plans
       WHERE code = $1`,
      [user.plan_code],
    );
    const plan = planResult.rows[0];
    if (!plan) {
      throw new Error('plan not found');
    }
    const window = currentWindow(user);
    const usage = await this.ensureWindow(userId, window.start, window.end);
    const remainingSeconds = Math.max(
      0,
      plan.max_listening_seconds_per_window - usage.listening_seconds_used,
    );
    const remainingNotes = unlimitedNotes(plan.max_notes_per_window)
      ? null
      : Math.max(0, (plan.max_notes_per_window ?? 0) - usage.notes_counted);
    return {
      plan: user.plan_code,
      remainingSeconds,
      remainingNotes,
    };
  }

  private async ensureWindow(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<WindowRow> {
    const existing = await this.db.query<WindowRow>(
      `SELECT listening_seconds_used, notes_counted
       FROM usage_windows
       WHERE user_id = $1 AND period_start = $2`,
      [userId, periodStart.toISOString()],
    );
    if (existing.rows[0]) {
      return existing.rows[0];
    }
    const inserted = await this.db.query<WindowRow>(
      `INSERT INTO usage_windows (user_id, period_start, period_end)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, period_start) DO UPDATE SET
         period_end = EXCLUDED.period_end
       RETURNING listening_seconds_used, notes_counted`,
      [userId, periodStart.toISOString(), periodEnd.toISOString()],
    );
    return inserted.rows[0] ?? { listening_seconds_used: 0, notes_counted: 0 };
  }
}

function unlimitedNotes(maxNotes: number | null): boolean {
  return maxNotes === null || maxNotes === 0;
}

function currentWindow(user: UserRow): { start: Date; end: Date } {
  const now = new Date();
  if (user.plan_code === 'paid') {
    const anchor = user.subscription_period_start ?? user.created_at;
    return monthlyWindow(anchor, now);
  }
  const origin = user.created_at.getTime();
  const n = Math.max(0, Math.floor((now.getTime() - origin) / FREE_WINDOW_MS));
  const start = new Date(origin + n * FREE_WINDOW_MS);
  const end = new Date(origin + (n + 1) * FREE_WINDOW_MS);
  return { start, end };
}

function monthlyWindow(anchor: Date, now: Date): { start: Date; end: Date } {
  const day = anchor.getUTCDate();
  let start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0),
  );
  start.setUTCDate(Math.min(day, daysInUtcMonth(start)));
  start.setUTCHours(
    anchor.getUTCHours(),
    anchor.getUTCMinutes(),
    anchor.getUTCSeconds(),
    anchor.getUTCMilliseconds(),
  );
  if (start.getTime() > now.getTime()) {
    start = addUtcMonths(start, -1);
    start.setUTCDate(Math.min(day, daysInUtcMonth(start)));
  }
  const end = addUtcMonths(start, 1);
  return { start, end };
}

function addUtcMonths(date: Date, delta: number): Date {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + delta);
  return next;
}

function daysInUtcMonth(date: Date): number {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
}
