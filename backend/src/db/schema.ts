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
  ('paid', 360000, NULL, 0, NULL, NULL)
ON CONFLICT (code) DO NOTHING;

UPDATE plans
SET max_notes_per_window = 0, updated_at = now()
WHERE code = 'paid' AND max_notes_per_window IS NULL
`;
