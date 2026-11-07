export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS plans (
    code TEXT PRIMARY KEY CHECK (code IN ('free', 'paid')),
    max_listening_seconds_per_window INTEGER NOT NULL,
    max_seconds_per_note INTEGER,
    max_notes_per_window INTEGER,
    stripe_price_id_monthly TEXT,
    stripe_price_id_yearly TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    google_subject TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    plan_code TEXT NOT NULL DEFAULT 'free' REFERENCES plans(code),
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    stripe_price_id TEXT,
    subscription_period_start TIMESTAMPTZ,
    subscription_period_end TIMESTAMPTZ,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS usage_windows (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    listening_seconds_used INTEGER NOT NULL DEFAULT 0,
    notes_counted INTEGER NOT NULL DEFAULT 0,
    UNIQUE (user_id, period_start)
  )`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES workspaces(id),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title TEXT,
    status TEXT NOT NULL CHECK (
      status IN ('listening', 'paused', 'processing', 'ready', 'failed')
    ),
    summary_text TEXT,
    transcript_text TEXT,
    language TEXT CHECK (language IN ('en', 'es')),
    error_code TEXT CHECK (error_code IN ('upload', 'stt', 'gpt')),
    error_message TEXT,
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    duration_seconds INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS notes_workspace_id_idx ON notes (workspace_id)`,
  `CREATE INDEX IF NOT EXISTS notes_user_id_idx ON notes (user_id)`,
  `CREATE INDEX IF NOT EXISTS workspaces_user_id_idx ON workspaces (user_id)`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS transcript_turns TEXT`,
  `ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS icon TEXT NOT NULL DEFAULT 'circle'`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS final_seq INTEGER`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary_running BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS typed_notes TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT`,
  `CREATE TABLE IF NOT EXISTS note_slices (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    note_id UUID NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
    source TEXT NOT NULL CHECK (source IN ('mic', 'system', 'mix')),
    start_sec DOUBLE PRECISION NOT NULL,
    end_sec DOUBLE PRECISION NOT NULL,
    wav_path TEXT,
    transcript TEXT,
    language TEXT CHECK (language IN ('en', 'es')),
    attempts INTEGER NOT NULL DEFAULT 0,
    locked_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (note_id, seq)
  )`,
  `CREATE INDEX IF NOT EXISTS note_slices_claim_idx ON note_slices (status, created_at)`,
  `ALTER TABLE note_slices ADD COLUMN IF NOT EXISTS content_sha256 TEXT`,
  `ALTER TABLE note_slices ADD COLUMN IF NOT EXISTS retry_after TIMESTAMPTZ`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary_lease TEXT`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary_lease_until TIMESTAMPTZ`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary_from_transcript BOOLEAN NOT NULL DEFAULT false`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS summary_attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE notes ADD COLUMN IF NOT EXISTS transcript_complete BOOLEAN NOT NULL DEFAULT true`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_cancel_error TEXT`,
  `CREATE TABLE IF NOT EXISTS listen_ledger (
    note_id UUID PRIMARY KEY REFERENCES notes(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seconds INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_paused BOOLEAN NOT NULL DEFAULT false`,
  `CREATE TABLE IF NOT EXISTS former_accounts (
    email TEXT PRIMARY KEY,
    google_subject TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ,
    free_eligible_at TIMESTAMPTZ
  )`,
  `ALTER TABLE former_accounts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`,
  `ALTER TABLE former_accounts ADD COLUMN IF NOT EXISTS free_eligible_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_event_at TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS checkout_session_id TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS checkout_session_url TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS checkout_session_expires TIMESTAMPTZ`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS checkout_price_id TEXT`,
  `CREATE TABLE IF NOT EXISTS stripe_events (
    event_id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS wav_cleanup (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wav_path TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS former_accounts_google_subject_idx
   ON former_accounts (google_subject)
   WHERE google_subject IS NOT NULL`,
  `DO $$
   DECLARE
     constraint_name text;
   BEGIN
     SELECT con.conname INTO constraint_name
     FROM pg_constraint con
     JOIN pg_class rel ON rel.oid = con.conrelid
     JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
     WHERE rel.relname = 'plans'
       AND nsp.nspname = 'public'
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) ILIKE '%free%';
     IF constraint_name IS NOT NULL THEN
       EXECUTE format('ALTER TABLE plans DROP CONSTRAINT %I', constraint_name);
     END IF;
   END $$`,
  `ALTER TABLE plans ADD CONSTRAINT plans_code_check CHECK (code IN ('free', 'paid', 'plus'))`,
];

export const SEED_PLANS_SQL = `
INSERT INTO plans (
  code,
  max_listening_seconds_per_window,
  max_seconds_per_note,
  max_notes_per_window,
  stripe_price_id_monthly,
  stripe_price_id_yearly
) VALUES
  ('free', 3600, 1800, 10, NULL, NULL),
  ('paid', 144000, NULL, 0, NULL, NULL)
ON CONFLICT (code) DO NOTHING;

UPDATE plans
SET max_notes_per_window = 0, updated_at = now()
WHERE code = 'paid' AND max_notes_per_window IS NULL;

UPDATE plans
SET max_listening_seconds_per_window = 144000, updated_at = now()
WHERE code = 'paid' AND max_listening_seconds_per_window = 360000;

INSERT INTO plans (
  code,
  max_listening_seconds_per_window,
  max_seconds_per_note,
  max_notes_per_window,
  stripe_price_id_monthly,
  stripe_price_id_yearly
) VALUES
  ('plus', 144000, NULL, 0, NULL, NULL)
ON CONFLICT (code) DO NOTHING;
`;
