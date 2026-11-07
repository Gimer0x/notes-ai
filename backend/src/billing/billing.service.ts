import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { readPublicAppConfig } from '../config/app-config';
import { DbService } from '../db/db.service';
import type { UserRow } from '../users/user.types';

export type BillingStatus = {
  plan: 'free' | 'paid';
  planInterval: 'month' | 'year' | null;
  remainingSeconds: number;
  remainingNotes: number | null;
  accessUntil: string | null;
  billingPaused: boolean;
  freeEligibleAt: string | null;
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
export const FREE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Active renewals keep paid hours for one day after period end if the webhook is late. */
export const PAID_GRACE_MS = 24 * 60 * 60 * 1000;

export function paidAccessEnded(
  user: {
    plan_code: string;
    subscription_paused: boolean;
    subscription_period_end: Date | string | null;
  },
  now = new Date(),
): boolean {
  if (user.plan_code !== 'paid' || !user.subscription_period_end) {
    return false;
  }
  const end = new Date(user.subscription_period_end).getTime();
  if (Number.isNaN(end)) {
    return false;
  }
  if (user.subscription_paused) {
    return now.getTime() >= end;
  }
  return now.getTime() >= end + PAID_GRACE_MS;
}

export function freeQuotaWindow(createdAt: Date): { start: Date; end: Date } {
  const start = new Date(createdAt);
  return { start, end: new Date(start.getTime() + FREE_WINDOW_MS) };
}

@Injectable()
export class BillingService {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  async getStatus(userId: string): Promise<BillingStatus> {
    const userResult = await this.db.query<UserRow>(
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
         subscription_period_end,
         subscription_paused
       FROM users
       WHERE id = $1`,
      [userId],
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new Error('user not found');
    }
    const quota = quotaIdentity(user);
    const planResult = await this.db.query<PlanRow>(
      `SELECT code, max_listening_seconds_per_window, max_notes_per_window
       FROM plans
       WHERE code = $1`,
      [quota.plan_code],
    );
    const plan = planResult.rows[0];
    if (!plan) {
      throw new Error('plan not found');
    }
    const window = currentWindow(quota);
    const usage = await this.ensureWindow(userId, window.start, window.end);
    let remainingSeconds = Math.max(
      0,
      plan.max_listening_seconds_per_window - usage.listening_seconds_used,
    );
    let remainingNotes = unlimitedNotes(plan.max_notes_per_window)
      ? null
      : Math.max(0, (plan.max_notes_per_window ?? 0) - usage.notes_counted);
    let freeEligibleAt: string | null = null;
    if (quota.plan_code === 'free') {
      const former = await this.db.query<{ free_eligible_at: Date | null }>(
        `SELECT free_eligible_at FROM former_accounts
         WHERE lower(email) = lower($1) OR google_subject = $2
         ORDER BY free_eligible_at DESC NULLS LAST
         LIMIT 1`,
        [user.email, user.google_subject],
      );
      const eligible = former.rows[0]?.free_eligible_at;
      if (eligible && new Date(eligible).getTime() > Date.now()) {
        remainingSeconds = 0;
        remainingNotes = 0;
        freeEligibleAt = new Date(eligible).toISOString();
      }
    }
    const periodEnd = user.subscription_period_end
      ? new Date(user.subscription_period_end)
      : null;
    const paidNow = quota.plan_code === 'paid';
    return {
      plan: quota.plan_code,
      planInterval: paidNow ? await this.intervalFor(user) : null,
      remainingSeconds,
      remainingNotes,
      accessUntil:
        paidNow && periodEnd && !Number.isNaN(periodEnd.getTime())
          ? periodEnd.toISOString()
          : null,
      billingPaused: paidNow && Boolean(user.subscription_paused),
      freeEligibleAt,
    };
  }

  async canStartNote(
    userId: string,
  ): Promise<{ allowed: boolean; reason?: string }> {
    const status = await this.getStatus(userId);
    const minListen = readPublicAppConfig(this.config).minListenSeconds;
    if (status.remainingSeconds < minListen) {
      return { allowed: false, reason: 'no_listening_time' };
    }
    if (status.remainingNotes === 0) {
      return { allowed: false, reason: 'no_notes' };
    }
    return { allowed: true };
  }

  async recordListen(
    userId: string,
    noteId: string,
    durationSeconds: number,
    query: DbService['query'] = this.db.query.bind(this.db),
  ): Promise<void> {
    const ledger = await query<{ note_id: string }>(
      `INSERT INTO listen_ledger (note_id, user_id, seconds)
       VALUES ($1, $2, $3)
       ON CONFLICT (note_id) DO NOTHING
       RETURNING note_id`,
      [noteId, userId, Math.max(0, Math.round(durationSeconds))],
    );
    if (!ledger.rows[0]) {
      return;
    }
    const userResult = await query<UserRow>(
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
         subscription_period_end,
         subscription_paused
       FROM users
       WHERE id = $1`,
      [userId],
    );
    const user = userResult.rows[0];
    if (!user) {
      throw new Error('user not found');
    }
    const window = currentWindow(quotaIdentity(user));
    await this.ensureWindow(userId, window.start, window.end, query);
    const seconds = Math.max(0, Math.round(durationSeconds));
    await query(
      `UPDATE usage_windows
       SET listening_seconds_used = listening_seconds_used + $3,
           notes_counted = notes_counted + 1
       WHERE user_id = $1 AND period_start = $2`,
      [userId, window.start.toISOString(), seconds],
    );
  }

  private async intervalFor(user: UserRow): Promise<'month' | 'year' | null> {
    if (user.plan_code !== 'paid') {
      return null;
    }
    const prices = await this.db.query<{
      monthly: string | null;
      yearly: string | null;
    }>(
      `SELECT stripe_price_id_monthly AS monthly, stripe_price_id_yearly AS yearly
       FROM plans WHERE code = 'paid'`,
    );
    const row = prices.rows[0];
    const priceId = user.stripe_price_id?.trim() ?? '';
    if (priceId && row?.yearly && priceId === row.yearly) {
      return 'year';
    }
    if (priceId && row?.monthly && priceId === row.monthly) {
      return 'month';
    }
    return null;
  }

  private async ensureWindow(
    userId: string,
    periodStart: Date,
    periodEnd: Date,
    query: DbService['query'] = this.db.query.bind(this.db),
  ): Promise<WindowRow> {
    const existing = await query<WindowRow>(
      `SELECT listening_seconds_used, notes_counted
       FROM usage_windows
       WHERE user_id = $1 AND period_start = $2`,
      [userId, periodStart.toISOString()],
    );
    if (existing.rows[0]) {
      return existing.rows[0];
    }
    const inserted = await query<WindowRow>(
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

function quotaIdentity(user: UserRow): UserRow {
  if (!paidAccessEnded(user)) {
    return user;
  }
  return { ...user, plan_code: 'free', subscription_paused: false };
}

function currentWindow(user: UserRow, now = new Date()): { start: Date; end: Date } {
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

/** One monthly bucket from a stable UTC anniversary. The day is clamped after the month is chosen. */
export function monthlyWindow(anchor: Date, now: Date): { start: Date; end: Date } {
  const day = anchor.getUTCDate();
  const hours = anchor.getUTCHours();
  const minutes = anchor.getUTCMinutes();
  const seconds = anchor.getUTCSeconds();
  const ms = anchor.getUTCMilliseconds();
  const boundary = (year: number, month: number): Date => {
    const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(day, days), hours, minutes, seconds, ms));
  };
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  let start = boundary(year, month);
  if (start.getTime() > now.getTime()) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    start = boundary(year, month);
  }
  let endMonth = month + 1;
  let endYear = year;
  if (endMonth > 11) {
    endMonth = 0;
    endYear += 1;
  }
  return { start, end: boundary(endYear, endMonth) };
}
