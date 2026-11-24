-- =============================================================================
-- Content OS — Phase 1 — Migration 0200: functions, RPCs and triggers
--
-- Conventions
--   * Every SECURITY DEFINER function pins `search_path = ''` and fully
--     qualifies every identifier (prevents search_path hijacking).
--   * Every mutating RPC re-checks authorization itself using auth.uid().
--     Never trust arguments for identity.
--   * EXECUTE is revoked from PUBLIC and granted explicitly in 0300.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Authorization helpers (used by RLS policies; SECURITY DEFINER so policies
-- on workspace_members do not recurse into themselves).
-- ---------------------------------------------------------------------------
create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.is_platform_admin from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

create or replace function public.workspace_role_of(p_workspace_id uuid)
returns public.workspace_role
language sql
stable
security definer
set search_path = ''
as $$
  select m.role
  from public.workspace_members m
  where m.workspace_id = p_workspace_id
    and m.user_id = auth.uid();
$$;

create or replace function public.is_workspace_member(p_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
  );
$$;

create or replace function public.has_workspace_role(
  p_workspace_id uuid,
  p_roles public.workspace_role[]
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = auth.uid()
      and m.role = any (p_roles)
  );
$$;

-- True when the current user shares at least one workspace with p_user_id.
create or replace function public.shares_workspace_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.workspace_members mine
    join public.workspace_members theirs
      on theirs.workspace_id = mine.workspace_id
    where mine.user_id = auth.uid()
      and theirs.user_id = p_user_id
  );
$$;

-- ---------------------------------------------------------------------------
-- Audit logging (internal only — not executable by clients)
-- ---------------------------------------------------------------------------
create or replace function public.log_audit_event(
  p_workspace_id uuid,
  p_action text,
  p_entity_type text default null,
  p_entity_id text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs (workspace_id, actor_id, action, entity_type, entity_id, metadata)
  values (
    p_workspace_id,
    coalesce(p_actor_id, auth.uid()),
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce(p_metadata, '{}'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Profile provisioning from auth.users
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    coalesce(new.email, ''),
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), 120), '')
  )
  on conflict (id) do nothing;

  perform public.log_audit_event(null, 'user.registered', 'user', new.id::text, '{}'::jsonb, new.id);
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.handle_user_email_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.email is distinct from old.email then
    update public.profiles set email = coalesce(new.email, '') where id = new.id;
  end if;
  return new;
end;
$$;

create trigger on_auth_user_email_changed
  after update of email on auth.users
  for each row execute function public.handle_user_email_change();

-- ---------------------------------------------------------------------------
-- Credit ledger: the ONLY way to change a balance.
-- Locks the balance row, validates, writes ledger + balance atomically.
-- Idempotent when p_idempotency_key is supplied.
-- Internal: granted to service_role only (see 0300).
-- ---------------------------------------------------------------------------
create or replace function public.apply_credit_transaction(
  p_workspace_id uuid,
  p_type public.credit_transaction_type,
  p_amount integer,
  p_reason text,
  p_feature text default null,
  p_idempotency_key text default null,
  p_metadata jsonb default '{}'::jsonb,
  p_actor_id uuid default null
)
returns public.usage_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_balance integer;
  v_new_balance integer;
  v_txn public.usage_transactions;
begin
  if p_amount is null or p_amount = 0 then
    raise exception 'amount must be non-zero' using errcode = '22023';
  end if;

  -- Serialise all ledger writes for this workspace.
  select balance into v_balance
  from public.usage_credits
  where workspace_id = p_workspace_id
  for update;

  if not found then
    raise exception 'workspace % has no credit account', p_workspace_id using errcode = 'P0002';
  end if;

  if p_idempotency_key is not null then
    select * into v_txn from public.usage_transactions
    where workspace_id = p_workspace_id and idempotency_key = p_idempotency_key;
    if found then
      return v_txn;  -- replay: no double charge
    end if;
  end if;

  v_new_balance := v_balance + p_amount;
  if v_new_balance < 0 then
    raise exception 'insufficient credits: balance %, requested %', v_balance, p_amount
      using errcode = 'P0001', hint = 'insufficient_credits';
  end if;

  insert into public.usage_transactions (
    workspace_id, type, amount, balance_after, reason, feature,
    idempotency_key, metadata, created_by
  ) values (
    p_workspace_id, p_type, p_amount, v_new_balance, p_reason, p_feature,
    p_idempotency_key, coalesce(p_metadata, '{}'::jsonb), coalesce(p_actor_id, auth.uid())
  )
  returning * into v_txn;

  update public.usage_credits
  set balance = v_new_balance, updated_at = now()
  where workspace_id = p_workspace_id;

  return v_txn;
end;
$$;

-- Platform-admin manual adjustment (callable by authenticated; checks admin).
create or replace function public.admin_adjust_credits(
  p_workspace_id uuid,
  p_amount integer,
  p_reason text
)
returns public.usage_transactions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_txn public.usage_transactions;
begin
  if not public.is_platform_admin() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) < 3 then
    raise exception 'a reason of at least 3 characters is required' using errcode = '22023';
  end if;

  v_txn := public.apply_credit_transaction(
    p_workspace_id, 'adjustment', p_amount, btrim(p_reason), null, null,
    jsonb_build_object('source', 'admin_panel'), auth.uid()
  );

  perform public.log_audit_event(
    p_workspace_id, 'credits.adjusted', 'usage_transaction', v_txn.id::text,
    jsonb_build_object('amount', p_amount, 'balance_after', v_txn.balance_after)
  );
  return v_txn;
end;
$$;

-- ---------------------------------------------------------------------------
-- Workspace creation (atomic): workspace + owner membership + settings +
-- free subscription + credit account + initial grant + audit.
-- ---------------------------------------------------------------------------
create or replace function public.create_workspace(p_name text, p_slug text)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_ws public.workspaces;
  v_plan public.plans;
  v_owned integer;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  if not exists (
    select 1 from auth.users u where u.id = v_user and u.email_confirmed_at is not null
  ) then
    raise exception 'email address must be verified before creating a workspace'
      using errcode = '42501';
  end if;

  -- Abuse guard: cap workspaces owned per user.
  select count(*) into v_owned from public.workspaces where owner_id = v_user;
  if v_owned >= 5 then
    raise exception 'workspace limit reached' using errcode = '54000';
  end if;

  select * into v_plan from public.plans where id = 'free' and is_active;
  if not found then
    raise exception 'default plan "free" is not configured' using errcode = 'P0002';
  end if;

  insert into public.workspaces (name, slug, owner_id)
  values (btrim(p_name), lower(btrim(p_slug)), v_user)
  returning * into v_ws;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_ws.id, v_user, 'owner');

  insert into public.workspace_settings (workspace_id) values (v_ws.id);

  insert into public.subscriptions (workspace_id, plan_id, status)
  values (v_ws.id, v_plan.id, 'active');

  insert into public.usage_credits (workspace_id, balance) values (v_ws.id, 0);

  if v_plan.monthly_credits > 0 then
    perform public.apply_credit_transaction(
      v_ws.id, 'grant', v_plan.monthly_credits,
      'Initial ' || v_plan.name || ' plan allocation', null,
      'initial-grant', jsonb_build_object('plan_id', v_plan.id), v_user
    );
  end if;

  perform public.log_audit_event(
    v_ws.id, 'workspace.created', 'workspace', v_ws.id::text,
    jsonb_build_object('name', v_ws.name, 'slug', v_ws.slug)
  );

  return v_ws;
end;
$$;

-- ---------------------------------------------------------------------------
-- Membership management
-- ---------------------------------------------------------------------------
create or replace function public.workspace_seat_usage(p_workspace_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select count(*)::int from public.workspace_members where workspace_id = p_workspace_id)
    +
    (select count(*)::int from public.workspace_invitations
      where workspace_id = p_workspace_id
        and accepted_at is null and revoked_at is null and expires_at > now());
$$;

create or replace function public.workspace_seat_limit(p_workspace_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.max_members
     from public.subscriptions s join public.plans p on p.id = s.plan_id
     where s.workspace_id = p_workspace_id),
    1
  );
$$;

-- Returns the plaintext token ONCE. Only its hash is stored.
create or replace function public.create_workspace_invitation(
  p_workspace_id uuid,
  p_email text,
  p_role public.workspace_role default 'member'
)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor_role public.workspace_role := public.workspace_role_of(p_workspace_id);
  v_email text := lower(btrim(p_email));
  v_token text;
  v_inv public.workspace_invitations;
begin
  if v_actor_role is null or v_actor_role = 'member' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'cannot invite as owner' using errcode = '22023';
  end if;
  if p_role = 'admin' and v_actor_role <> 'owner' then
    raise exception 'only the owner can invite admins' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.workspace_members m
    join public.profiles p on p.id = m.user_id
    where m.workspace_id = p_workspace_id and lower(p.email) = v_email
  ) then
    raise exception 'user is already a member' using errcode = '23505';
  end if;
  if public.workspace_seat_usage(p_workspace_id) >= public.workspace_seat_limit(p_workspace_id) then
    raise exception 'member limit reached for current plan' using errcode = '54000';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');

  insert into public.workspace_invitations (workspace_id, email, role, token_hash, invited_by)
  values (
    p_workspace_id, v_email, p_role,
    encode(extensions.digest(v_token, 'sha256'), 'hex'), auth.uid()
  )
  returning * into v_inv;

  perform public.log_audit_event(
    p_workspace_id, 'invitation.created', 'invitation', v_inv.id::text,
    jsonb_build_object('role', p_role)
  );

  invitation_id := v_inv.id;
  token := v_token;
  expires_at := v_inv.expires_at;
  return next;
end;
$$;

create or replace function public.revoke_workspace_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv public.workspace_invitations;
begin
  select * into v_inv from public.workspace_invitations where id = p_invitation_id;
  if not found
     or not public.has_workspace_role(v_inv.workspace_id, array['owner','admin']::public.workspace_role[]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.workspace_invitations set revoked_at = now()
  where id = p_invitation_id and accepted_at is null and revoked_at is null;

  perform public.log_audit_event(v_inv.workspace_id, 'invitation.revoked', 'invitation', v_inv.id::text);
end;
$$;

create or replace function public.accept_workspace_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_email text;
  v_confirmed timestamptz;
  v_inv public.workspace_invitations;
begin
  if v_user is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  select lower(u.email), u.email_confirmed_at into v_email, v_confirmed
  from auth.users u where u.id = v_user;

  if v_confirmed is null then
    raise exception 'email address must be verified' using errcode = '42501';
  end if;

  select * into v_inv from public.workspace_invitations
  where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
  for update;

  -- Same error for "unknown", "revoked", "expired", "accepted", "wrong email"
  -- to avoid leaking invitation existence.
  if not found
     or v_inv.accepted_at is not null
     or v_inv.revoked_at is not null
     or v_inv.expires_at <= now()
     or lower(v_inv.email) <> v_email then
    raise exception 'invitation is invalid or has expired' using errcode = '22023';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (v_inv.workspace_id, v_user, v_inv.role)
  on conflict (workspace_id, user_id) do nothing;

  update public.workspace_invitations
  set accepted_at = now(), accepted_by = v_user
  where id = v_inv.id;

  perform public.log_audit_event(
    v_inv.workspace_id, 'member.joined', 'user', v_user::text,
    jsonb_build_object('role', v_inv.role, 'invitation_id', v_inv.id)
  );
  return v_inv.workspace_id;
end;
$$;

create or replace function public.update_member_role(
  p_workspace_id uuid,
  p_user_id uuid,
  p_role public.workspace_role
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_target_role public.workspace_role;
begin
  if public.workspace_role_of(p_workspace_id) is distinct from 'owner' then
    raise exception 'only the owner can change roles' using errcode = '42501';
  end if;
  if p_role = 'owner' then
    raise exception 'ownership transfer is not supported in this phase' using errcode = '22023';
  end if;

  select role into v_target_role from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if v_target_role = 'owner' then
    raise exception 'the owner role cannot be changed' using errcode = '42501';
  end if;

  update public.workspace_members set role = p_role
  where workspace_id = p_workspace_id and user_id = p_user_id;

  perform public.log_audit_event(
    p_workspace_id, 'member.role_changed', 'user', p_user_id::text,
    jsonb_build_object('from', v_target_role, 'to', p_role)
  );
end;
$$;

-- Owner: may remove any non-owner. Admin: may remove members only.
-- Anyone except the owner may remove themselves (leave).
create or replace function public.remove_workspace_member(p_workspace_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_role public.workspace_role := public.workspace_role_of(p_workspace_id);
  v_target_role public.workspace_role;
begin
  if v_actor_role is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  select role into v_target_role from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id
  for update;

  if not found then
    raise exception 'member not found' using errcode = 'P0002';
  end if;
  if v_target_role = 'owner' then
    raise exception 'the owner cannot be removed' using errcode = '42501';
  end if;

  if p_user_id <> v_actor then
    if v_actor_role = 'member'
       or (v_actor_role = 'admin' and v_target_role <> 'member') then
      raise exception 'not authorized' using errcode = '42501';
    end if;
  end if;

  delete from public.workspace_members
  where workspace_id = p_workspace_id and user_id = p_user_id;

  perform public.log_audit_event(
    p_workspace_id,
    case when p_user_id = v_actor then 'member.left' else 'member.removed' end,
    'user', p_user_id::text,
    jsonb_build_object('role', v_target_role)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Social connection: disconnect (owner/admin). Connect is performed by the
-- server (service_role) after a verified OAuth exchange.
-- ---------------------------------------------------------------------------
create or replace function public.disconnect_social_account(p_workspace_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acc public.social_accounts;
begin
  if not public.has_workspace_role(p_workspace_id, array['owner','admin']::public.workspace_role[]) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  delete from public.social_accounts where workspace_id = p_workspace_id
  returning * into v_acc;   -- credentials cascade

  if v_acc.id is not null then
    perform public.log_audit_event(
      p_workspace_id, 'social.disconnected', 'social_account', v_acc.id::text,
      jsonb_build_object('platform', v_acc.platform, 'username', v_acc.username)
    );
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Audit triggers for direct (RLS-governed) updates
-- ---------------------------------------------------------------------------
create or replace function public.audit_workspace_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.name is distinct from old.name then
    perform public.log_audit_event(
      new.id, 'workspace.renamed', 'workspace', new.id::text,
      jsonb_build_object('from', old.name, 'to', new.name)
    );
  end if;
  return new;
end;
$$;
create trigger workspaces_audit_update after update on public.workspaces
  for each row execute function public.audit_workspace_update();

create or replace function public.audit_workspace_settings_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_changed text[] := array[]::text[];
begin
  if new.timezone is distinct from old.timezone then v_changed := array_append(v_changed, 'timezone'); end if;
  if new.default_language is distinct from old.default_language then v_changed := array_append(v_changed, 'default_language'); end if;
  if new.content_niche is distinct from old.content_niche then v_changed := array_append(v_changed, 'content_niche'); end if;
  if new.brand_voice is distinct from old.brand_voice then v_changed := array_append(v_changed, 'brand_voice'); end if;
  if new.target_audience is distinct from old.target_audience then v_changed := array_append(v_changed, 'target_audience'); end if;
  if cardinality(v_changed) > 0 then
    perform public.log_audit_event(
      new.workspace_id, 'settings.updated', 'workspace_settings', new.workspace_id::text,
      jsonb_build_object('fields', to_jsonb(v_changed))
    );
  end if;
  return new;
end;
$$;
create trigger workspace_settings_audit_update after update on public.workspace_settings
  for each row execute function public.audit_workspace_settings_update();

create or replace function public.audit_social_account_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform public.log_audit_event(
      new.workspace_id, 'social.connected', 'social_account', new.id::text,
      jsonb_build_object('platform', new.platform, 'status', new.status, 'username', new.username),
      new.connected_by
    );
  elsif tg_op = 'UPDATE' and new.status is distinct from old.status then
    perform public.log_audit_event(
      new.workspace_id, 'social.status_changed', 'social_account', new.id::text,
      jsonb_build_object('from', old.status, 'to', new.status)
    );
  end if;
  return new;
end;
$$;
create trigger social_accounts_audit after insert or update on public.social_accounts
  for each row execute function public.audit_social_account_change();

create or replace function public.audit_subscription_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.plan_id is distinct from old.plan_id or new.status is distinct from old.status then
    perform public.log_audit_event(
      new.workspace_id, 'subscription.changed', 'subscription', new.id::text,
      jsonb_build_object(
        'from_plan', old.plan_id, 'to_plan', new.plan_id,
        'from_status', old.status, 'to_status', new.status
      )
    );
  end if;
  return new;
end;
$$;
create trigger subscriptions_audit_update after update on public.subscriptions
  for each row execute function public.audit_subscription_change();

-- Prevent privilege escalation via profiles even if column grants are
-- misconfigured later: only service_role / postgres may flip the admin flag.
create or replace function public.guard_profile_admin_flag()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.is_platform_admin is distinct from old.is_platform_admin
     and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception 'is_platform_admin cannot be modified by clients' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger profiles_guard_admin_flag before update on public.profiles
  for each row execute function public.guard_profile_admin_flag();
