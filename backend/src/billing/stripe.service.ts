import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Stripe from 'stripe';
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
    if (user.plan_code === 'paid') {
      throw new ConflictException('already_paid');
    }
    const priceId = await this.priceIdFor(interval);
    if (!priceId) {
      throw new BadRequestException('stripe_price_missing');
    }
    const website = this.websiteOrigin();
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${website}/account?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${website}/pricing`,
      client_reference_id: user.id,
      metadata: { userId: user.id },
      ...(user.stripe_customer_id
        ? { customer: user.stripe_customer_id }
        : { customer_email: user.email }),
    });
    if (!session.url) {
      throw new BadRequestException('stripe_session_failed');
    }
    return { url: session.url };
  }

  async syncSubscription(userId: string, sessionId?: string): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user || user.plan_code === 'paid') {
      return;
    }
    const stripe = this.requireStripe();
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
      throw new BadRequestException('STRIPE_WEBHOOK_SECRET is not set');
    }
    if (!signature) {
      throw new UnauthorizedException('missing stripe signature');
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
        await this.applySubscription(subscription, userId);
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
      await this.applySubscription(subscription, user?.id ?? null);
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
      return;
    }
    await this.db.query(
      `UPDATE users SET
         plan_code = $2,
         stripe_customer_id = $3,
         stripe_subscription_id = $4,
         stripe_price_id = $5,
         subscription_period_start = $6,
         subscription_period_end = $7,
         updated_at = now()
       WHERE id = $1`,
      [
        targetId,
        paid ? 'paid' : 'free',
        customerId,
        subscription.id,
        priceId,
        periodStart ? new Date(periodStart * 1000) : null,
        periodEnd ? new Date(periodEnd * 1000) : null,
      ],
    );
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
      throw new BadRequestException('STRIPE_SECRET_KEY is not set');
    }
    return this.stripe;
  }

  private websiteOrigin(): string {
    return (
      this.config.get<string>('WEBSITE_URL')?.trim().replace(/\/$/, '') ||
      'http://localhost:5173'
    );
  }

  async cancelSubscription(subscriptionId: string): Promise<void> {
    if (!this.stripe) {
      return;
    }
    try {
      await this.stripe.subscriptions.cancel(subscriptionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'stripe_cancel_failed';
      this.logger.warn(`subscription cancel skipped: ${message}`);
    }
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
