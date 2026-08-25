import cookieParser from 'cookie-parser';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { DbService } from '../src/db/db.service';

export async function createTestApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    logger: false,
  });
  app.use(cookieParser());
  await app.init();
  return app;
}

export async function resetDb(app: INestApplication): Promise<void> {
  const db = app.get(DbService);
  await db.query(
    'TRUNCATE TABLE notes, workspaces, usage_windows, users CASCADE',
  );
  await db.query(
    `UPDATE plans
     SET stripe_price_id_monthly = NULL,
         stripe_price_id_yearly = NULL,
         updated_at = now()
     WHERE code = 'paid'`,
  );
}

export async function insertUser(
  app: INestApplication,
  row: {
    email: string;
    subject: string;
    plan?: 'free' | 'paid';
    stripePriceId?: string | null;
  },
): Promise<{ id: string }> {
  const db = app.get(DbService);
  const result = await db.query<{ id: string }>(
    `INSERT INTO users (google_subject, email, plan_code, stripe_price_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [row.subject, row.email, row.plan ?? 'free', row.stripePriceId ?? null],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new Error('failed to insert user');
  }
  return { id };
}
