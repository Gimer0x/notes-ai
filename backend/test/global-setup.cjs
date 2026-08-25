const { Client } = require('pg');

const ADMIN_URL =
  process.env.TEST_POSTGRES_ADMIN_URL ||
  'postgres://pith:pith@127.0.0.1:5432/pith';
const PEER_URL =
  process.env.TEST_POSTGRES_PEER_URL || 'postgres://127.0.0.1/postgres';
const TEST_URL =
  process.env.DATABASE_URL ||
  'postgres://pith:pith@127.0.0.1:5432/pith_test';

async function canConnect(url) {
  const client = new Client({ connectionString: url });
  try {
    await client.connect();
    await client.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function ensureRoleAndDatabase(adminUrl) {
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pith') THEN
          CREATE ROLE pith LOGIN PASSWORD 'pith';
        END IF;
      END
      $$;
    `);
    const { rows } = await admin.query(
      `SELECT 1 FROM pg_database WHERE datname = 'pith_test'`,
    );
    if (rows.length === 0) {
      await admin.query('CREATE DATABASE pith_test OWNER pith');
    }
  } finally {
    await admin.end();
  }
}

module.exports = async function globalSetup() {
  if (await canConnect(TEST_URL)) {
    return;
  }
  const admins = [ADMIN_URL, PEER_URL];
  let lastError;
  for (const url of admins) {
    try {
      await ensureRoleAndDatabase(url);
      if (await canConnect(TEST_URL)) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
  }
  console.error(
    'Postgres is required for backend e2e tests. From backend/, run: docker compose up -d',
  );
  throw lastError || new Error('could not create pith_test');
};
