import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
import { paidAccessEnded } from './billing.service';
import { cancellationFailureCode } from '../common/safe-error';
import { DbService } from '../db/db.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class StripeService implements OnModuleInit {
  private readonly logger = new Logger(StripeService.name);
  private stripe: Stripe | null = null;

  constructor(
    private readonly config: ConfigService,
    private readonly db: DbService,
    private readonly users: UsersService,
  ) {}

  async onModuleInit(): Promise<void> {
    const key = this.config.get<string>('STRIPE_SECRET_KEY')?.trim();
    if (key) {
      this.stripe = new Stripe(key);
    }
    const monthly = this.config.get<string>('STRIPE_PRICE_ID_MONTHLY')?.trim();
    const yearly = this.config.get<string>('STRIPE_PRICE_ID_YEARLY')?.trim();
    if (monthly) {
      await this.db.query(
        `UPDATE plans SET stripe_price_id_monthly = $1, updated_at = now() WHERE code = 'paid'`,
        [monthly],
      );
    }
    if (yearly) {
      await this.db.query(
        `UPDATE plans SET stripe_price_id_yearly = $1, updated_at = now() WHERE code = 'paid'`,
        [yearly],
      );
    }
    const plusMonthly = this.config.get<string>('STRIPE_PRICE_ID_PLUS_MONTHLY')?.trim();
    const plusYearly = this.config.get<string>('STRIPE_PRICE_ID_PLUS_YEARLY')?.trim();
    if (plusMonthly) {
      await this.db.query(
        `UPDATE plans SET stripe_price_id_monthly = $1, updated_at = now() WHERE code = 'plus'`,
        [plusMonthly],
      );
    }
    if (plusYearly) {
      await this.db.query(
        `UPDATE plans SET stripe_price_id_yearly = $1, updated_at = now() WHERE code = 'plus'`,
        [plusYearly],
      );
    }
  }

  async pauseAtPeriodEnd(userId: string): Promise<{ accessUntil: string }> {
    const row = await this.db.query<{
      plan_code: 'free' | 'paid';
      stripe_subscription_id: string | null;
      subscription_paused: boolean;
      subscription_period_end: Date | null;
    }>(
      `SELECT plan_code, stripe_subscription_id, subscription_paused, subscription_period_end
       FROM users WHERE id = $1`,
      [userId],
    );
    const user = row.rows[0];
    if (!user || user.plan_code !== 'paid' || !user.stripe_subscription_id) {
      throw new ConflictException('not_paid');
    }
    if (user.subscription_paused && user.subscription_period_end) {
      return { accessUntil: new Date(user.subscription_period_end).toISOString() };
    }
    const stripe = this.requireStripe();
    let subscription: Stripe.Subscription;
    try {
      subscription = await stripe.subscriptions.update(user.stripe_subscription_id, {
        cancel_at_period_end: true,
      });
    } catch {
      throw new BadGatewayException('pause_failed');
    }
    await this.applySubscription(subscription, userId);
    const end = periodUnix(subscription, 'end');
    if (!end) {
      throw new BadGatewayException('pause_failed');
    }
    return { accessUntil: new Date(end * 1000).toISOString() };
  }

  async resumeSubscription(userId: string): Promise<{ renewsOn: string }> {
    const row = await this.db.query<{
      plan_code: 'free' | 'paid';
      stripe_subscription_id: string | null;
      subscription_paused: boolean;
      subscription_period_end: Date | null;
    }>(
      `SELECT plan_code, stripe_subscription_id, subscription_paused, subscription_period_end
       FROM users WHERE id = $1`,
      [userId],
    );
    const user = row.rows[0];
    if (!user || user.plan_code !== 'paid' || !user.stripe_subscription_id || !user.subscription_paused) {
      throw new ConflictException('not_paused');
    }
    const stripe = this.requireStripe();
    let subscription: Stripe.Subscription;
    try {
      subscription = await stripe.subscriptions.update(user.stripe_subscription_id, {
        cancel_at_period_end: false,
      });
    } catch {
      throw new BadGatewayException('resume_failed');
    }
    await this.applySubscription(subscription, userId);
    const end = periodUnix(subscription, 'end') ?? (
      user.subscription_period_end ? Math.floor(new Date(user.subscription_period_end).getTime() / 1000) : null
    );
    if (!end) {
      throw new BadGatewayException('resume_failed');
    }
    return { renewsOn: new Date(end * 1000).toISOString() };
  }

  async createCheckoutSession(
    userId: string,
    interval: 'month' | 'year',
  ): Promise<{ url: string }> {
    const stripe = this.requireStripe();
    const user = await this.users.findById(userId);
    if (!user) {
      throw new BadRequestException('user not found');
    }
    if (user.plan_code === 'paid' && !paidAccessEnded(user)) {
      throw new ConflictException('already_paid');
    }
    const priceId = await this.priceIdFor(interval);
    if (!priceId) {
      throw new BadRequestException('stripe_price_missing');
    }
    return this.db.transaction(async (query) => {
      await query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [userId]);
      const pending = await query<{
        checkout_session_id: string | null;
        checkout_session_url: string | null;
        checkout_session_expires: Date | null;
        checkout_price_id: string | null;
      }>(
        `SELECT checkout_session_id, checkout_session_url, checkout_session_expires, checkout_price_id
         FROM users WHERE id = $1`,
        [userId],
      );
      const open = pending.rows[0];
      if (
        open?.checkout_session_id &&
        open.checkout_session_url &&
        open.checkout_price_id === priceId &&
        open.checkout_session_expires &&
        new Date(open.checkout_session_expires).getTime() > Date.now()
      ) {
        try {
          const existing = await stripe.checkout.sessions.retrieve(open.checkout_session_id);
          if (existing.status === 'open') {
            return { url: open.checkout_session_url };
          }
        } catch {
          // The stored session is gone. Create a new one.
        }
      }
      const website = this.websiteOrigin();
      const session = await stripe.checkout.sessions.create(
        {
          mode: 'subscription',
          line_items: [{ price: priceId, quantity: 1 }],
          success_url: `${website}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${website}/pricing`,
          client_reference_id: user.id,
          metadata: { userId: user.id },
          subscription_data: { metadata: { userId: user.id } },
          ...(user.stripe_customer_id
            ? { customer: user.stripe_customer_id }
            : { customer_email: user.email }),
        },
        { idempotencyKey: `checkout-${userId}-${priceId}-${open?.checkout_session_id ?? 'new'}` },
      );
      if (!session.url) {
        throw new BadRequestException('stripe_session_failed');
      }
      if (open?.checkout_session_id && open.checkout_session_id !== session.id) {
        await stripe.checkout.sessions.expire(open.checkout_session_id).catch(() => undefined);
      }
      const expires = session.expires_at
        ? new Date(session.expires_at * 1000)
        : new Date(Date.now() + 30 * 60 * 1000);
      await query(
        `UPDATE users SET
           checkout_session_id = $2,
           checkout_session_url = $3,
           checkout_session_expires = $4,
           checkout_price_id = $5,
           updated_at = now()
         WHERE id = $1`,
        [userId, session.id, session.url, expires, priceId],
      );
      return { url: session.url };
    });
  }

  async syncSubscription(userId: string, sessionId?: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) {
      return;
    }
    const stripe = this.requireStripe();
    if (user.plan_code === 'paid' && !paidAccessEnded(user)) {
      return;
    }
    if (paidAccessEnded(user) && user.stripe_subscription_id) {
      try {
        const subscription = await stripe.subscriptions.retrieve(user.stripe_subscription_id);
        await this.applySubscription(subscription, user.id);
        return;
      } catch {
        // Fall through and look up the customer by email.
      }
    }
    if (user.plan_code === 'paid') {
      return;
    }
    if (sessionId) {
      await this.syncFromSession(stripe, user.id, sessionId);
      const updated = await this.users.findById(userId);
      if (updated?.plan_code === 'paid') {
        return;
      }
    }
    await this.syncFromEmail(stripe, user.id, user.email);
  }

  async handleWebhook(rawBody: Buffer, signature: string | undefined): Promise<void> {
    const stripe = this.requireStripe();
    const secret = this.config.get<string>('STRIPE_WEBHOOK_SECRET')?.trim();
    if (!secret) {
      throw new ServiceUnavailableException('stripe_unconfigured');
    }
    if (!signature) {
      throw new UnauthorizedException('stripe_signature');
    }
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, secret);
    } catch {
      throw new UnauthorizedException('invalid stripe signature');
    }
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.client_reference_id || session.metadata?.userId;
      const subscriptionId =
        typeof session.subscription === 'string' ? session.subscription : session.subscription?.id;
      if (userId && subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const owner = await this.users.findById(userId);
        if (!owner) {
          await this.cancelSubscription(subscriptionId).catch(() => undefined);
          return;
        }
        await this.applySubscription(subscription, userId, {
          id: event.id,
          created: event.created,
        });
      }
      return;
    }
    if (
      event.type === 'customer.subscription.updated' ||
      event.type === 'customer.subscription.deleted'
    ) {
      const subscription = event.data.object as Stripe.Subscription;
      const customerId =
        typeof subscription.customer === 'string'
          ? subscription.customer
          : subscription.customer.id;
      const user = await this.users.findByStripeCustomerId(customerId);
      await this.applySubscription(subscription, user?.id ?? null, {
        id: event.id,
        created: event.created,
      });
    }
  }

  private async syncFromSession(
    stripe: Stripe,
    userId: string,
    sessionId: string,
  ): Promise<void> {
    let session: Stripe.Checkout.Session;
    try {
      session = await stripe.checkout.sessions.retrieve(sessionId);
    } catch {
      return;
    }
    if (session.client_reference_id !== userId) {
      throw new ForbiddenException('checkout_session_user');
    }
    await this.applyCheckoutSession(stripe, session, userId);
  }

  private async syncFromEmail(
    stripe: Stripe,
    userId: string,
    email: string,
  ): Promise<void> {
    const customers = await stripe.customers.list({ email, limit: 20 });
    const matches: { created: number; subscriptionId: string }[] = [];
    for (const customer of customers.data) {
      const sessions = await stripe.checkout.sessions.list({
        customer: customer.id,
        limit: 20,
      });
      for (const session of sessions.data) {
        if (session.client_reference_id !== userId || session.status !== 'complete') {
          continue;
        }
        const subscriptionId = subscriptionIdOf(session.subscription);
        if (subscriptionId) {
          matches.push({ created: session.created, subscriptionId });
        }
      }
    }
    matches.sort((left, right) => right.created - left.created);
    for (const match of matches) {
      const subscription = await stripe.subscriptions.retrieve(match.subscriptionId);
      if (subscription.status === 'active' || subscription.status === 'trialing') {
        await this.applySubscription(subscription, userId);
        return;
      }
    }
    const newest = matches[0];
    if (newest) {
      const subscription = await stripe.subscriptions.retrieve(newest.subscriptionId);
      await this.applySubscription(subscription, userId);
    }
  }

  private async applyCheckoutSession(
    stripe: Stripe,
    session: Stripe.Checkout.Session,
    userId: string,
  ): Promise<void> {
    const subscriptionId = subscriptionIdOf(session.subscription);
    if (!subscriptionId || session.status !== 'complete') {
      return;
    }
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    await this.applySubscription(subscription, userId);
  }

  private async applySubscription(
    subscription: Stripe.Subscription,
    userId: string | null,
    event?: { id: string; created: number },
  ): Promise<void> {
    const customerId =
      typeof subscription.customer === 'string'
        ? subscription.customer
        : subscription.customer.id;
    const item = subscription.items.data[0];
    const priceId = item?.price.id ?? null;
    const periodStart = periodUnix(subscription, 'start');
    const periodEnd = periodUnix(subscription, 'end');
    const paid =
      subscription.status === 'active' || subscription.status === 'trialing';
    const targetId = userId ?? (await this.users.findByStripeCustomerId(customerId))?.id;
    if (!targetId) {
      this.logger.warn(`stripe subscription ${subscription.id} has no matching user`);
      if (paid) {
        await this.cancelSubscription(subscription.id).catch(() => undefined);
      }
      return;
    }
    const current = await this.db.query<{
      stripe_subscription_id: string | null;
      subscription_event_at: Date | null;
      subscription_period_end: Date | null;
    }>(
      `SELECT stripe_subscription_id, subscription_event_at, subscription_period_end
       FROM users WHERE id = $1`,
      [targetId],
    );
    const row = current.rows[0];
    const eventAt = event ? new Date(event.created * 1000) : new Date();
    if (row && !this.subscriptionEventApplies(row, subscription, eventAt, paid)) {
      return;
    }
    if (event?.id) {
      const inserted = await this.db.query(
        `INSERT INTO stripe_events (event_id) VALUES ($1)
         ON CONFLICT DO NOTHING
         RETURNING event_id`,
        [event.id],
      );
      if (inserted.rowCount === 0) {
        return;
      }
    }
    const updated = await this.db.query(
      `UPDATE users SET
         plan_code = $2,
         stripe_customer_id = $3,
         stripe_subscription_id = $4,
         stripe_price_id = $5,
         subscription_period_start = $6,
         subscription_period_end = $7,
         subscription_paused = $8,
         subscription_event_at = $9,
         checkout_session_id = NULL,
         checkout_session_url = NULL,
         checkout_session_expires = NULL,
         checkout_price_id = NULL,
         updated_at = now()
       WHERE id = $1
       RETURNING id`,
      [
        targetId,
        paid ? 'paid' : 'free',
        customerId,
        paid ? subscription.id : row?.stripe_subscription_id === subscription.id ? null : subscription.id,
        priceId,
        periodStart ? new Date(periodStart * 1000) : null,
        periodEnd ? new Date(periodEnd * 1000) : null,
        paid && subscription.cancel_at_period_end === true,
        eventAt,
      ],
    );
    if (updated.rowCount === 0 && paid) {
      await this.cancelSubscription(subscription.id).catch(() => undefined);
    }
  }

  private subscriptionEventApplies(
    row: {
      stripe_subscription_id: string | null;
      subscription_event_at: Date | null;
      subscription_period_end: Date | null;
    },
    subscription: Stripe.Subscription,
    eventAt: Date,
    paid: boolean,
  ): boolean {
    const currentId = row.stripe_subscription_id;
    if (currentId && currentId !== subscription.id) {
      const periodEnd = row.subscription_period_end
        ? new Date(row.subscription_period_end).getTime()
        : 0;
      const currentStillPaid = periodEnd > Date.now();
      const incomingCreated = (subscription.created ?? 0) * 1000;
      const currentEvent = row.subscription_event_at
        ? new Date(row.subscription_event_at).getTime()
        : 0;
      if (currentStillPaid && !paid) {
        return false;
      }
      if (currentStillPaid && incomingCreated > 0 && incomingCreated < currentEvent) {
        return false;
      }
    }
    if (
      currentId === subscription.id &&
      row.subscription_event_at &&
      eventAt.getTime() < new Date(row.subscription_event_at).getTime()
    ) {
      return false;
    }
    return true;
  }

  private async priceIdFor(interval: 'month' | 'year'): Promise<string | null> {
    const column =
      interval === 'year' ? 'stripe_price_id_yearly' : 'stripe_price_id_monthly';
    const result = await this.db.query<{ price_id: string | null }>(
      `SELECT ${column} AS price_id FROM plans WHERE code = 'paid'`,
    );
    return result.rows[0]?.price_id?.trim() || null;
  }

  private requireStripe(): Stripe {
    if (!this.stripe) {
      throw new ServiceUnavailableException('stripe_unconfigured');
    }
    return this.stripe;
  }

  private websiteOrigin(): string {
    return (
      this.config.get<string>('WEBSITE_URL')?.trim().replace(/\/$/, '') ||
      'http://localhost:5173'
    );
  }

  async cancelAccountBilling(userId: string): Promise<void> {
    const row = await this.db.query<{
      stripe_subscription_id: string | null;
      stripe_customer_id: string | null;
      checkout_session_id: string | null;
    }>(
      `SELECT stripe_subscription_id, stripe_customer_id, checkout_session_id
       FROM users WHERE id = $1`,
      [userId],
    );
    const user = row.rows[0];
    if (!user) {
      return;
    }
    if (user.stripe_subscription_id) {
      await this.cancelSubscription(user.stripe_subscription_id);
    }
    if (this.stripe && user.stripe_customer_id) {
      const listed = await this.stripe.subscriptions
        .list({ customer: user.stripe_customer_id, status: 'active', limit: 20 })
        .catch(() => null);
      for (const subscription of listed?.data ?? []) {
        if (
          subscription.metadata?.userId === userId &&
          subscription.id !== user.stripe_subscription_id
        ) {
          await this.cancelSubscription(subscription.id);
        }
      }
    }
    if (this.stripe && user.checkout_session_id) {
      await this.stripe.checkout.sessions.expire(user.checkout_session_id).catch(() => undefined);
    }
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    if (!this.stripe) {
      await this.rememberCancelError(subscriptionId, 'stripe_unavailable');
      throw new ServiceUnavailableException('stripe_unavailable');
    }
    try {
      await this.stripe.subscriptions.cancel(subscriptionId);
      await this.rememberCancelError(subscriptionId, null);
    } catch (error) {
      if (cancellationFailureCode(error) === 'gone') {
        await this.rememberCancelError(subscriptionId, null);
        return;
      }
      this.logger.warn('subscription cancel failed');
      await this.rememberCancelError(subscriptionId, 'stripe_cancel_failed');
      throw new BadGatewayException('stripe_cancel_failed');
    }
  }

  private async rememberCancelError(subscriptionId: string, code: string | null): Promise<void> {
    await this.db.query(
      `UPDATE users
       SET subscription_cancel_error = $2, updated_at = now()
       WHERE stripe_subscription_id = $1`,
      [subscriptionId, code],
    );
  }
}

function subscriptionIdOf(
  subscription: Stripe.Checkout.Session['subscription'],
): string | null {
  if (!subscription) {
    return null;
  }
  return typeof subscription === 'string' ? subscription : subscription.id;
}

function periodUnix(
  subscription: Stripe.Subscription,
  which: 'start' | 'end',
): number | null {
  const item = subscription.items.data[0] as
    | (Stripe.SubscriptionItem & {
        current_period_start?: number;
        current_period_end?: number;
      })
    | undefined;
  if (which === 'start') {
    return (
      (subscription as Stripe.Subscription & { current_period_start?: number })
        .current_period_start ??
      item?.current_period_start ??
      null
    );
  }
  return (
    (subscription as Stripe.Subscription & { current_period_end?: number })
      .current_period_end ??
    item?.current_period_end ??
    null
  );
}
