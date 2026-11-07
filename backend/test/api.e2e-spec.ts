import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { BillingService } from '../src/billing/billing.service';
import { UsersService } from '../src/users/users.service';
import { SlicesService } from '../src/slices/slices.service';
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
      pictureUrl: null,
      plan: 'free',
      planInterval: null,
      remainingNotes: 10,
    });
    expect(body.remainingSeconds).toBe(3600);
    expect(body.accessUntil).toBeNull();
    expect(body.billingPaused).toBe(false);
    expect(body.freeEligibleAt).toBeNull();
    expect(body).not.toHaveProperty('quota');
  });

  it('POST /me/pause rejects a free account', async () => {
    const user = await insertUser(app, {
      email: 'pause-free@example.com',
      subject: 'sub-pause-free',
    });
    const token = signUserToken(user.id, JWT_SECRET);
    await request(app.getHttpServer())
      .post('/me/pause')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'PAUSE' })
      .expect(409);
  });

  it('POST /me/resume rejects an account that is not paused', async () => {
    const user = await insertUser(app, {
      email: 'resume-free@example.com',
      subject: 'sub-resume-free',
    });
    const token = signUserToken(user.id, JWT_SECRET);
    await request(app.getHttpServer())
      .post('/me/resume')
      .set('Authorization', `Bearer ${token}`)
      .send({ confirm: 'RESUME' })
      .expect(409);
  });

  it('a deleted email does not get a fresh free window', async () => {
    const users = app.get(UsersService);
    const user = await insertUser(app, {
      email: 'former@example.com',
      subject: 'sub-former',
    });
    await users.deleteAccount(user.id);
    const again = await users.upsertFromGoogle({
      subject: 'sub-former-again',
      email: 'Former@example.com',
      displayName: null,
      picture: null,
    });
    const token = signUserToken(again.id, JWT_SECRET);
    const { body } = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(body.plan).toBe('free');
    expect(body.remainingSeconds).toBe(0);
    expect(body.remainingNotes).toBe(0);
    expect(body.freeEligibleAt).toEqual(expect.any(String));
  });

  it('free access returns 30 days after deletion', async () => {
    const users = app.get(UsersService);
    const db = app.get(DbService);
    const user = await insertUser(app, {
      email: 'later@example.com',
      subject: 'sub-later',
    });
    await users.deleteAccount(user.id);
    await db.query(
      `UPDATE former_accounts SET free_eligible_at = now() - interval '1 minute'
       WHERE lower(email) = lower($1)`,
      ['later@example.com'],
    );
    const again = await users.upsertFromGoogle({
      subject: 'sub-later-again',
      email: 'later@example.com',
      displayName: null,
      picture: null,
    });
    const token = signUserToken(again.id, JWT_SECRET);
    const { body } = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(body.remainingSeconds).toBe(3600);
    expect(body.freeEligibleAt).toBeNull();
  });

  it('an expired paused subscription does not keep paid hours', async () => {
    const db = app.get(DbService);
    const user = await insertUser(app, {
      email: 'expired@example.com',
      subject: 'sub-expired',
      plan: 'paid',
    });
    await db.query(
      `UPDATE users
       SET subscription_paused = true,
           subscription_period_start = now() - interval '40 days',
           subscription_period_end = now() - interval '1 hour'
       WHERE id = $1`,
      [user.id],
    );
    const token = signUserToken(user.id, JWT_SECRET);
    const { body } = await request(app.getHttpServer())
      .get('/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(body.plan).toBe('free');
    expect(body.billingPaused).toBe(false);
    expect(body.remainingSeconds).toBe(3600);
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
    expect(body.remainingSeconds).toBe(144000);
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
    await request(app.getHttpServer()).post('/billing/sync').send({}).expect(401);

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

  it('workspaces and notes follow the list, delete, move, and rename rules', async () => {
    const user = await insertUser(app, {
      email: 'notes@example.com',
      subject: 'sub-notes',
    });
    const token = signUserToken(user.id, JWT_SECRET);
    const http = request(app.getHttpServer());

    await http.get('/workspaces').expect(401);
    await http.post('/workspaces').send({ name: 'Client' }).expect(401);

    const listed = await http
      .get('/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(listed.body).toHaveLength(1);
    expect(listed.body[0].name).toBe('Personal');
    expect(listed.body[0].icon).toBe('circle');
    const icon = await http
      .patch(`/workspaces/${listed.body[0].id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ icon: 'home' })
      .expect(200);
    expect(icon.body.icon).toBe('home');
    const personalId = listed.body[0].id as string;

    await http
      .delete(`/workspaces/${personalId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);

    const created = await http
      .post('/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: '  Client A  ' })
      .expect(201);
    const clientId = created.body.id as string;
    expect(created.body.name).toBe('Client A');

    const note = await http
      .post(`/workspaces/${personalId}/notes`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Weekly sync' })
      .expect(201);
    expect(note.body).toMatchObject({
      workspaceId: personalId,
      title: 'Weekly sync',
      status: 'listening',
      summaryText: [],
      transcriptText: null,
    });
    const noteId = note.body.id as string;

    const notes = await http
      .get(`/workspaces/${personalId}/notes`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(notes.body).toHaveLength(1);

    await http
      .delete(`/workspaces/${personalId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);

    await http
      .delete(`/workspaces/${clientId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);

    const renamed = await http
      .patch(`/notes/${noteId}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ title: 'Renamed sync' })
      .expect(200);
    expect(renamed.body.title).toBe('Renamed sync');

    const second = await http
      .post('/workspaces')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Client B' })
      .expect(201);
    const moved = await http
      .post(`/notes/${noteId}/move`)
      .set('Authorization', `Bearer ${token}`)
      .send({ workspaceId: second.body.id })
      .expect(200);
    expect(moved.body.workspaceId).toBe(second.body.id);

    const db = app.get(DbService);
    await db.query(`UPDATE notes SET status = 'processing' WHERE id = $1`, [noteId]);
    await http
      .delete(`/notes/${noteId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    await db.query(`UPDATE notes SET status = 'failed', transcript_text = NULL WHERE id = $1`, [
      noteId,
    ]);
    await http
      .post(`/notes/${noteId}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .expect(409);
    await db.query(
      `UPDATE notes
       SET status = 'failed', transcript_text = 'Saved speech', error_code = 'gpt'
       WHERE id = $1`,
      [noteId],
    );
    const retried = await http
      .post(`/notes/${noteId}/retry`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(retried.body.status).toBe('processing');
    // The timer is disabled in tests; run one durable job explicitly.
    await (app.get(SlicesService) as any).maybeSummarize(noteId);
    const finished = await http.get(`/notes/${noteId}`).set('Authorization', `Bearer ${token}`).expect(200);
    expect(finished.body.status).toBe('ready');
    expect(finished.body.summaryText).toEqual(['Saved speech']);
    await db.query(`UPDATE notes SET status = 'listening' WHERE id = $1`, [noteId]);
    const stopped = await http
      .post(`/notes/${noteId}/stop`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        durationSeconds: 42.2,
        transcriptText: 'Hello there',
        language: 'en',
      })
      .expect(200);
    expect(stopped.body.status).toBe('ready');
    expect(stopped.body.durationSeconds).toBe(42);
    expect(stopped.body.transcriptText).toBe('Hello there');
    expect(stopped.body.language).toBe('en');
    expect(stopped.body.summaryText).toEqual(['Hello there']);

    await http
      .delete(`/notes/${noteId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
    await http
      .delete(`/workspaces/${second.body.id}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(204);
  });

  it('does not register POST /spike/transcribe outside development', async () => {
    await request(app.getHttpServer())
      .post('/spike/transcribe')
      .expect(404);
  });
});
