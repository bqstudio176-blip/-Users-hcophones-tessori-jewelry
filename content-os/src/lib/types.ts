import type { WorkspaceRole } from "@/lib/auth/permissions";

/** Row shapes read by the app (hand-written; regenerate with `supabase gen types` later). */
export interface Profile {
  id: string;
  email: string;
  full_name: string | null;
  avatar_url: string | null;
  preferences: Record<string, unknown>;
  is_platform_admin: boolean;
  created_at: string;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  slug: string;
  owner_id: string;
  created_at: string;
}

export interface Membership {
  role: WorkspaceRole;
  workspace: WorkspaceSummary;
}

export interface WorkspaceSettings {
  workspace_id: string;
  timezone: string;
  default_language: string;
  content_niche: string | null;
  brand_voice: string | null;
  target_audience: string | null;
  updated_at: string;
}

export interface Plan {
  id: string;
  name: string;
  description: string | null;
  price_cents: number;
  currency: string;
  monthly_credits: number;
  max_members: number;
  features: string[];
}

export interface Subscription {
  id: string;
  workspace_id: string;
  plan_id: string;
  status: "trialing" | "active" | "past_due" | "canceled" | "incomplete";
  current_period_start: string;
  current_period_end: string;
  cancel_at: string | null;
  plan?: Plan | null;
}

export interface UsageTransaction {
  id: string;
  workspace_id: string;
  type: "grant" | "consume" | "refund" | "adjustment" | "expire";
  amount: number;
  balance_after: number;
  reason: string;
  feature: string | null;
  created_by: string | null;
  created_at: string;
}

export interface SocialAccount {
  id: string;
  workspace_id: string;
  platform: "instagram";
  status: "pending" | "connected" | "expired" | "revoked" | "error";
  username: string | null;
  display_name: string | null;
  profile_picture_url: string | null;
  account_type: string | null;
  scopes: string[];
  connected_at: string | null;
  last_synced_at: string | null;
  last_error: string | null;
}

export interface AuditLog {
  id: number;
  workspace_id: string | null;
  actor_id: string | null;
  action: string;
  entity_type: string | null;
  entity_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface ActionState {
  status: "idle" | "success" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Optional payload (e.g. a one-time invitation link). */
  data?: Record<string, string>;
}

export const IDLE: ActionState = { status: "idle" };
