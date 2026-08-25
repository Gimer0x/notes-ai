import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BillingService } from '../src/billing/billing.service';
import { DbService } from '../src/db/db.service';
import { signUserToken } from '../src/auth/jwt';
import { createTestApp, insertUser, resetDb } from './app';

const JWT_SECRET = 'test-jwt-secret-do-not-use-elsewhere';

describe('API contracts (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDb(app);
  });

  it('GET /health', async () => {
    await request(app.getHttpServer()).get('/health').expect(200, { ok: true });
  });

  it('GET /config exposes env timings', async () => {
    const { body } = await request(app.getHttpServer()).get('/config').expect(200);
    expect(body).toEqual({
      minListenSeconds: 30,
      pauseAutoCancelSeconds: 1200,
      pauseWarningSeconds: 60,
      uploadRetrySeconds: 600,
      wavChunkSeconds: 600,
    });
  });

  it('GET /me is 401 without a token', async () => {
    await request(app.getHttpServer()).get('/me').expect(401);
  });

  it('GET /me returns plan, planInterval, and remaining quota', async () => {
    const user = await insertUser(app, {
      email: 'free@example.com',
      subject: 'sub-free',
    });
    const token = signUserToken(user.id, JWT_SECRET);
    const { body } = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(body).toMatchObject({
      id: user.id,
      email: 'free@example.com',
      plan: 'free',
      planInterval: null,
      remainingNotes: 10,
    });
    expect(body.remainingSeconds).toBe(3600);
    expect(body).not.toHaveProperty('quota');
  });

  it('GET /me accepts the website session cookie', async () => {
    const user = await insertUser(app, {
      email: 'cookie@example.com',
      subject: 'sub-cookie',
    });
    const token = signUserToken(user.id, JWT_SECRET);
    await request(app.getHttpServer())
      .get('/me')
      .set('Cookie', `pith_session=${token}`)
      .expect(200);
  });

  it('GET /me planInterval is month when stripe_price_id matches paid monthly', async () => {
    const db = app.get(DbService);
    await db.query(
      `UPDATE plans SET stripe_price_id_monthly = $1, stripe_price_id_yearly = $2
       WHERE code = 'paid'`,
      ['price_month_test', 'price_year_test'],
    );
    const user = await insertUser(app, {
      email: 'paid@example.com',
      subject: 'sub-paid',
      plan: 'paid',
      stripePriceId: 'price_month_test',
    });
    const token = signUserToken(user.id, JWT_SECRET);
    const { body } = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(body.plan).toBe('paid');
    expect(body.planInterval).toBe('month');
    expect(body.remainingNotes).toBeNull();
    expect(body.remainingSeconds).toBe(360000);
  });

  it('BillingService.canStartNote blocks when time or notes are exhausted', async () => {
    const billing = app.get(BillingService);
    const db = app.get(DbService);
    const user = await insertUser(app, {
      email: 'quota@example.com',
      subject: 'sub-quota',
    });
    expect(await billing.canStartNote(user.id)).toEqual({ allowed: true });

    const window = await db.query<{ period_start: Date; period_end: Date }>(
      `SELECT period_start, period_end FROM usage_windows WHERE user_id = $1`,
      [user.id],
    );
    expect(window.rows[0]).toBeDefined();
    await db.query(
      `UPDATE usage_windows SET listening_seconds_used = 3580 WHERE user_id = $1`,
      [user.id],
    );
    expect(await billing.canStartNote(user.id)).toEqual({
      allowed: false,
      reason: 'no_listening_time',
    });

    await db.query(
      `UPDATE usage_windows
       SET listening_seconds_used = 0, notes_counted = 10
       WHERE user_id = $1`,
      [user.id],
    );
    expect(await billing.canStartNote(user.id)).toEqual({
      allowed: false,
      reason: 'no_notes',
    });
  });

  it('POST /billing/checkout-session requires auth and a valid interval', async () => {
    await request(app.getHttpServer())
      .post('/billing/checkout-session')
      .send({ interval: 'month' })
      .expect(401);

    const user = await insertUser(app, {
      email: 'pay@example.com',
      subject: 'sub-pay',
    });
    const token = signUserToken(user.id, JWT_SECRET);
    await request(app.getHttpServer())
      .post('/billing/checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ interval: 'week' })
      .expect(400);
    await request(app.getHttpServer())
      .post('/billing/checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ interval: 'month' })
      .expect(400);
  });

  it('POST /billing/checkout-session is 409 when already paid', async () => {
    const user = await insertUser(app, {
      email: 'paid2@example.com',
      subject: 'sub-paid2',
      plan: 'paid',
    });
    const token = signUserToken(user.id, JWT_SECRET);
    const { body } = await request(app.getHttpServer())
      .post('/billing/checkout-session')
      .set('Authorization', `Bearer ${token}`)
      .send({ interval: 'month' })
      .expect(409);
    expect(body.message).toBe('already_paid');
  });

  it('POST /billing/webhook rejects a missing or invalid signature', async () => {
    await request(app.getHttpServer())
      .post('/billing/webhook')
      .set('Content-Type', 'application/json')
      .send({ type: 'checkout.session.completed' })
      .expect(401);
    await request(app.getHttpServer())
      .post('/billing/webhook')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', 'not-valid')
      .send({ type: 'checkout.session.completed' })
      .expect(401);
  });

  it('does not register POST /spike/transcribe outside development', async () => {
    await request(app.getHttpServer())
      .post('/spike/transcribe')
      .expect(404);
  });
});
