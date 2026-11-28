-- =============================================================================
-- Content OS — Phase 1 — Migration 0300: Row Level Security and privileges
--
-- Model (see SECURITY_PLAN.md):
--   * Deny by default: RLS is enabled on EVERY table; only explicit policies
--     grant access. Table privileges are also narrowed (defence in depth).
--   * Tenancy: a row is visible only to members of its workspace.
--   * Writes that need multi-row invariants go through SECURITY DEFINER RPCs
--     (0200), never direct INSERT/DELETE from clients.
--   * Platform admins get READ visibility across tenants via policies; their
--     only write path is admin_adjust_credits().
--   * Secrets (social_account_credentials) have NO client policies and NO
--     client privileges. Only service_role (server) can touch them.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Enable RLS everywhere
-- ---------------------------------------------------------------------------
alter table public.profiles                   enable row level security;
alter table public.plans                      enable row level security;
alter table public.workspaces                 enable row level security;
alter table public.workspace_members          enable row level security;
alter table public.workspace_invitations      enable row level security;
alter table public.workspace_settings         enable row level security;
alter table public.subscriptions              enable row level security;
alter table public.usage_credits              enable row level security;
alter table public.usage_transactions         enable row level security;
alter table public.social_accounts            enable row level security;
alter table public.social_account_credentials enable row level security;
alter table public.audit_logs                 enable row level security;

-- ---------------------------------------------------------------------------
-- 2. Privileges: start from nothing, then grant the minimum
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- Read access (rows still filtered by RLS)
grant select on
  public.profiles, public.plans, public.workspaces, public.workspace_members,
  public.workspace_invitations, public.workspace_settings, public.subscriptions,
  public.usage_credits, public.usage_transactions, public.social_accounts,
  public.audit_logs
to authenticated;

-- Column-scoped updates (rows still filtered by RLS)
grant update (full_name, avatar_url, preferences) on public.profiles to authenticated;
grant update (name) on public.workspaces to authenticated;
grant update (timezone, default_language, content_niche, brand_voice, target_audience)
  on public.workspace_settings to authenticated;

-- Plans are public marketing data (pricing page may read them signed-out).
grant select on public.plans to anon;

-- Ledgers are append-only for everyone except the table owner (cascades).
revoke update, delete, truncate on public.usage_transactions from service_role;
revoke update, delete, truncate on public.audit_logs         from service_role;

-- Secret table: nobody but service_role.
revoke all on public.social_account_credentials from anon, authenticated;

-- Functions callable by signed-in users (each re-checks authorization).
grant execute on function
  public.is_platform_admin(),
  public.workspace_role_of(uuid),
  public.is_workspace_member(uuid),
  public.has_workspace_role(uuid, public.workspace_role[]),
  public.shares_workspace_with(uuid),
  public.create_workspace(text, text),
  public.create_workspace_invitation(uuid, text, public.workspace_role),
  public.revoke_workspace_invitation(uuid),
  public.accept_workspace_invitation(text),
  public.update_member_role(uuid, uuid, public.workspace_role),
  public.remove_workspace_member(uuid, uuid),
  public.disconnect_social_account(uuid),
  public.admin_adjust_credits(uuid, integer, text),
  public.workspace_seat_usage(uuid),
  public.workspace_seat_limit(uuid)
to authenticated;

-- Server-only internals.
grant execute on function
  public.apply_credit_transaction(uuid, public.credit_transaction_type, integer, text, text, text, jsonb, uuid),
  public.log_audit_event(uuid, text, text, text, jsonb, uuid)
to service_role;

-- ---------------------------------------------------------------------------
-- 3. Policies
-- ---------------------------------------------------------------------------

-- profiles ------------------------------------------------------------------
create policy profiles_select_self_or_colleague on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or public.shares_workspace_with(id)
    or public.is_platform_admin()
  );

create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- plans ---------------------------------------------------------------------
create policy plans_select_active on public.plans
  for select to anon, authenticated
  using (is_active or public.is_platform_admin());

-- workspaces ----------------------------------------------------------------
create policy workspaces_select_member on public.workspaces
  for select to authenticated
  using (public.is_workspace_member(id) or public.is_platform_admin());

create policy workspaces_update_owner_admin on public.workspaces
  for update to authenticated
  using (public.has_workspace_role(id, array['owner','admin']::public.workspace_role[]))
  with check (public.has_workspace_role(id, array['owner','admin']::public.workspace_role[]));

-- workspace_members ---------------------------------------------------------
create policy workspace_members_select_member on public.workspace_members
  for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_admin());

-- workspace_invitations -----------------------------------------------------
create policy workspace_invitations_select_admin on public.workspace_invitations
  for select to authenticated
  using (
    public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[])
    or public.is_platform_admin()
  );

-- workspace_settings --------------------------------------------------------
create policy workspace_settings_select_member on public.workspace_settings
  for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_admin());

create policy workspace_settings_update_owner_admin on public.workspace_settings
  for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]));

-- subscriptions -------------------------------------------------------------
create policy subscriptions_select_member on public.subscriptions
  for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_admin());

-- usage_credits -------------------------------------------------------------
create policy usage_credits_select_member on public.usage_credits
  for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_admin());

-- usage_transactions --------------------------------------------------------
create policy usage_transactions_select_member on public.usage_transactions
  for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_admin());

-- social_accounts -----------------------------------------------------------
create policy social_accounts_select_member on public.social_accounts
  for select to authenticated
  using (public.is_workspace_member(workspace_id) or public.is_platform_admin());

-- social_account_credentials: intentionally NO policies.

-- audit_logs ----------------------------------------------------------------
create policy audit_logs_select_admin on public.audit_logs
  for select to authenticated
  using (
    (workspace_id is not null
      and public.has_workspace_role(workspace_id, array['owner','admin']::public.workspace_role[]))
    or (workspace_id is null and actor_id = (select auth.uid()))
    or public.is_platform_admin()
  );
