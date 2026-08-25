import {
  BadRequestException,
  ConflictException,
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
      success_url: `${website}/account?checkout=success`,
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
