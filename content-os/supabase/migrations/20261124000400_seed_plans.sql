-- =============================================================================
-- Content OS — Phase 1 — Migration 0400: plan catalogue
-- Reference data required by create_workspace(). Prices are placeholders until
-- billing is wired in a later phase; they are NOT charged anywhere.
-- =============================================================================
insert into public.plans (id, name, description, price_cents, monthly_credits, max_members, features, sort_order)
values
  ('free',    'Free',    'Explore Content OS with a single workspace.', 0,     50,   2,
     '["1 Instagram connection","50 monthly credits","2 members"]'::jsonb, 0),
  ('creator', 'Creator', 'For solo creators producing every week.',     2900,  500,  3,
     '["1 Instagram connection","500 monthly credits","3 members"]'::jsonb, 1),
  ('studio',  'Studio',  'For teams and agencies running production.',  9900,  2500, 10,
     '["1 Instagram connection","2,500 monthly credits","10 members"]'::jsonb, 2)
on conflict (id) do update set
  name = excluded.name,
  description = excluded.description,
  price_cents = excluded.price_cents,
  monthly_credits = excluded.monthly_credits,
  max_members = excluded.max_members,
  features = excluded.features,
  sort_order = excluded.sort_order;
