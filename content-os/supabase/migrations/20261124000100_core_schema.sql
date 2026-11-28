-- =============================================================================
-- Content OS — Phase 1 — Migration 0100: core schema
-- Tables, enums, constraints and indexes. Access control lives in 0300.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.workspace_role as enum ('owner', 'admin', 'member');

create type public.subscription_status as enum (
  'trialing', 'active', 'past_due', 'canceled', 'incomplete'
);

create type public.social_platform as enum ('instagram');

create type public.social_connection_status as enum (
  'pending', 'connected', 'expired', 'revoked', 'error'
);

create type public.credit_transaction_type as enum (
  'grant',       -- plan allocation / promotional credits (+)
  'consume',     -- usage of a metered feature (-)
  'refund',      -- reversal of a consume (+)
  'adjustment',  -- manual admin correction (+/-)
  'expire'       -- end-of-period expiry (-)
);

-- ---------------------------------------------------------------------------
-- Generic updated_at trigger
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles: 1:1 with auth.users
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                uuid primary key references auth.users (id) on delete cascade,
  email             text not null,
  full_name         text check (full_name is null or char_length(full_name) <= 120),
  avatar_url        text check (avatar_url is null or char_length(avatar_url) <= 2048),
  preferences       jsonb not null default '{}'::jsonb
                      check (jsonb_typeof(preferences) = 'object'),
  is_platform_admin boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index profiles_email_idx on public.profiles (lower(email));
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- plans: catalogue of subscription plans (platform-managed)
-- ---------------------------------------------------------------------------
create table public.plans (
  id               text primary key check (id ~ '^[a-z0-9_]{2,32}$'),
  name             text not null,
  description      text,
  price_cents      integer not null default 0 check (price_cents >= 0),
  currency         text not null default 'usd' check (currency ~ '^[a-z]{3}$'),
  monthly_credits  integer not null check (monthly_credits >= 0),
  max_members      integer not null check (max_members >= 1),
  features         jsonb not null default '[]'::jsonb,
  is_active        boolean not null default true,
  sort_order       integer not null default 0,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- workspaces: the tenant boundary
-- ---------------------------------------------------------------------------
create table public.workspaces (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 2 and 80),
  slug        text not null unique check (slug ~ '^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$'),
  owner_id    uuid not null references public.profiles (id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index workspaces_owner_idx on public.workspaces (owner_id);
create trigger workspaces_set_updated_at before update on public.workspaces
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- workspace_members
-- ---------------------------------------------------------------------------
create table public.workspace_members (
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  user_id      uuid not null references public.profiles (id) on delete cascade,
  role         public.workspace_role not null default 'member',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_members_user_idx on public.workspace_members (user_id);
-- Exactly one owner row per workspace (the owner is also workspaces.owner_id).
create unique index workspace_members_one_owner_idx
  on public.workspace_members (workspace_id) where role = 'owner';
create trigger workspace_members_set_updated_at before update on public.workspace_members
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- workspace_invitations
-- Token is never stored in plaintext; only its SHA-256 hash.
-- ---------------------------------------------------------------------------
create table public.workspace_invitations (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id) on delete cascade,
  email        text not null check (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  role         public.workspace_role not null default 'member' check (role <> 'owner'),
  token_hash   text not null unique,
  invited_by   uuid references public.profiles (id) on delete set null,
  expires_at   timestamptz not null default (now() + interval '7 days'),
  accepted_at  timestamptz,
  accepted_by  uuid references public.profiles (id) on delete set null,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
-- At most one open invitation per email per workspace.
create unique index workspace_invitations_open_idx
  on public.workspace_invitations (workspace_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- ---------------------------------------------------------------------------
-- workspace_settings: 1:1 with workspaces
-- ---------------------------------------------------------------------------
create table public.workspace_settings (
  workspace_id     uuid primary key references public.workspaces (id) on delete cascade,
  timezone         text not null default 'UTC' check (char_length(timezone) <= 64),
  default_language text not null default 'en' check (default_language ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  content_niche    text check (content_niche is null or char_length(content_niche) <= 120),
  brand_voice      text check (brand_voice is null or char_length(brand_voice) <= 2000),
  target_audience  text check (target_audience is null or char_length(target_audience) <= 2000),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create trigger workspace_settings_set_updated_at before update on public.workspace_settings
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- subscriptions: one per workspace (billing provider wiring is a later phase)
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  workspace_id             uuid not null unique references public.workspaces (id) on delete cascade,
  plan_id                  text not null references public.plans (id),
  status                   public.subscription_status not null default 'active',
  current_period_start     timestamptz not null default now(),
  current_period_end       timestamptz not null default (now() + interval '1 month'),
  cancel_at                timestamptz,
  provider                 text,          -- e.g. 'stripe' (Phase 2+)
  provider_customer_id     text,
  provider_subscription_id text unique,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  check (current_period_end > current_period_start)
);
create trigger subscriptions_set_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- usage_credits: current balance per workspace (materialised from the ledger)
-- ---------------------------------------------------------------------------
create table public.usage_credits (
  workspace_id uuid primary key references public.workspaces (id) on delete cascade,
  balance      integer not null default 0 check (balance >= 0),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- usage_transactions: append-only credit ledger
-- ---------------------------------------------------------------------------
create table public.usage_transactions (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null references public.workspaces (id) on delete cascade,
  type            public.credit_transaction_type not null,
  amount          integer not null check (amount <> 0),
  balance_after   integer not null check (balance_after >= 0),
  reason          text not null check (char_length(reason) between 1 and 200),
  feature         text check (feature is null or char_length(feature) <= 64),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) <= 128),
  metadata        jsonb not null default '{}'::jsonb,
  created_by      uuid references public.profiles (id) on delete set null,
  created_at      timestamptz not null default now(),
  -- Sign must match the transaction type.
  check (
    (type in ('grant', 'refund') and amount > 0) or
    (type in ('consume', 'expire') and amount < 0) or
    (type = 'adjustment')
  )
);
create index usage_transactions_ws_created_idx
  on public.usage_transactions (workspace_id, created_at desc);
create unique index usage_transactions_idempotency_idx
  on public.usage_transactions (workspace_id, idempotency_key)
  where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- social_accounts: public (non-secret) connection metadata.
-- UNIQUE(workspace_id) enforces ONE social connection per workspace.
-- ---------------------------------------------------------------------------
create table public.social_accounts (
  id                  uuid primary key default gen_random_uuid(),
  workspace_id        uuid not null references public.workspaces (id) on delete cascade,
  platform            public.social_platform not null default 'instagram',
  status              public.social_connection_status not null default 'pending',
  external_account_id text,
  username            text check (username is null or char_length(username) <= 64),
  display_name        text check (display_name is null or char_length(display_name) <= 120),
  profile_picture_url text check (profile_picture_url is null or char_length(profile_picture_url) <= 2048),
  account_type        text check (account_type is null or char_length(account_type) <= 32),
  scopes              text[] not null default '{}',
  connected_by        uuid references public.profiles (id) on delete set null,
  connected_at        timestamptz,
  last_synced_at      timestamptz,
  last_error          text check (last_error is null or char_length(last_error) <= 500),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint social_accounts_one_per_workspace unique (workspace_id)
);
create trigger social_accounts_set_updated_at before update on public.social_accounts
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- social_account_credentials: SECRET material. Never readable by clients.
-- Tokens are encrypted by the application (AES-256-GCM) before insert; the
-- database never sees plaintext. See SECURITY_PLAN.md §5.
-- ---------------------------------------------------------------------------
create table public.social_account_credentials (
  social_account_id      uuid primary key references public.social_accounts (id) on delete cascade,
  workspace_id           uuid not null unique references public.workspaces (id) on delete cascade,
  encrypted_access_token text not null,
  token_expires_at       timestamptz,
  key_version            smallint not null default 1,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);
create trigger social_account_credentials_set_updated_at before update on public.social_account_credentials
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- audit_logs: append-only security/activity log
-- ---------------------------------------------------------------------------
create table public.audit_logs (
  id           bigint generated always as identity primary key,
  workspace_id uuid references public.workspaces (id) on delete cascade,
  actor_id     uuid references public.profiles (id) on delete set null,
  action       text not null check (action ~ '^[a-z_]+\.[a-z_]+$'),
  entity_type  text,
  entity_id    text,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index audit_logs_ws_created_idx on public.audit_logs (workspace_id, created_at desc);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
