import type { Metadata } from "next";
import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Icons } from "@/components/ui/icons";
import { EmptyState, PageHeader, Stat } from "@/components/ui/states";
import { can, ROLE_LABELS } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { auditLabel, formatDate, formatNumber, formatRelative } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";
import { derivePendingTasks } from "@/lib/tasks";
import type { AuditLog, Plan, SocialAccount, Subscription, UsageTransaction, WorkspaceSettings } from "@/lib/types";

export const metadata: Metadata = { title: "Overview" };

const SOCIAL_TONE: Record<SocialAccount["status"], BadgeTone> = {
  connected: "success",
  pending: "info",
  expired: "warning",
  revoked: "warning",
  error: "danger",
};

export default async function DashboardPage() {
  const ctx = await getWorkspaceContext();
  const supabase = await createClient();
  const wsId = ctx.workspace.id;
  const canAudit = can(ctx.role, "audit.view");
  const canManage = can(ctx.role, "settings.update");

  // All reads go through the user's RLS-scoped client.
  const [settingsRes, membersRes, subRes, creditsRes, txnRes, socialRes, auditRes, invitesRes, scriptsRes, videosRes] = await Promise.all([
    supabase.from("workspace_settings").select("*").eq("workspace_id", wsId).maybeSingle(),
    supabase.from("workspace_members").select("user_id", { count: "exact", head: true }).eq("workspace_id", wsId),
    supabase.from("subscriptions").select("*, plan:plans(*)").eq("workspace_id", wsId).maybeSingle(),
    supabase.from("usage_credits").select("balance, updated_at").eq("workspace_id", wsId).maybeSingle(),
    supabase.from("usage_transactions").select("*").eq("workspace_id", wsId).order("created_at", { ascending: false }).limit(5),
    supabase.from("social_accounts").select("*").eq("workspace_id", wsId).maybeSingle(),
    canAudit
      ? supabase.from("audit_logs").select("*").eq("workspace_id", wsId).order("created_at", { ascending: false }).limit(6)
      : Promise.resolve({ data: [] as AuditLog[], error: null }),
    canManage
      ? supabase
          .from("workspace_invitations")
          .select("id", { count: "exact", head: true })
          .eq("workspace_id", wsId)
          .is("accepted_at", null)
          .is("revoked_at", null)
          .gt("expires_at", new Date().toISOString())
      : Promise.resolve({ count: 0, error: null }),
    supabase.from("scripts").select("id", { count: "exact", head: true }).eq("workspace_id", wsId),
    supabase.from("video_projects").select("id", { count: "exact", head: true }).eq("workspace_id", wsId),
  ]);

  const firstError = [settingsRes, membersRes, subRes, creditsRes, txnRes, socialRes, auditRes].find((r) => r.error)?.error;
  if (firstError) throw new Error(`Dashboard query failed: ${firstError.message}`);

  const settings = settingsRes.data as WorkspaceSettings | null;
  const subscription = subRes.data as (Subscription & { plan: Plan | null }) | null;
  const plan = subscription?.plan ?? null;
  const balance = (creditsRes.data as { balance: number } | null)?.balance ?? 0;
  const transactions = (txnRes.data ?? []) as UsageTransaction[];
  const social = socialRes.data as SocialAccount | null;
  const activity = (auditRes.data ?? []) as AuditLog[];
  const memberCount = membersRes.count ?? 0;
  const monthlyCredits = plan?.monthly_credits ?? 0;
  let usedThisPeriod = 0;
  if (subscription) {
    const { data: consumed, error } = await supabase
      .from("usage_transactions")
      .select("amount")
      .eq("workspace_id", wsId)
      .eq("type", "consume")
      .gte("created_at", subscription.current_period_start);
    if (error) throw new Error(`Usage query failed: ${error.message}`);
    usedThisPeriod = (consumed ?? []).reduce((sum, t) => sum - (t as { amount: number }).amount, 0);
  }

  const tasks = derivePendingTasks({
    canManage,
    socialStatus: social?.status ?? null,
    hasNiche: Boolean(settings?.content_niche),
    hasBrandVoice: Boolean(settings?.brand_voice),
    memberCount,
    seatLimit: plan?.max_members ?? 1,
    pendingInvitations: invitesRes.count ?? 0,
    creditBalance: balance,
    profileHasName: Boolean(ctx.profile.full_name),
  });
  const openTasks = tasks.filter((t) => !t.done);
  const firstName = ctx.profile.full_name?.split(" ")[0];

  return (
    <>
      <PageHeader
        title={firstName ? `Welcome back, ${firstName}` : "Overview"}
        description={
          <>
            <span className="text-fg">{ctx.workspace.name}</span> · {ROLE_LABELS[ctx.role]} · created {formatDate(ctx.workspace.created_at)}
          </>
        }
      />

      {/* Key stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card><CardContent><Stat label="Plan" value={plan?.name ?? "—"} hint={subscription ? <span className="capitalize">{subscription.status.replace("_", " ")}</span> : "No subscription"} /></CardContent></Card>
        <Card><CardContent><Stat label="Credits available" value={formatNumber(balance)} hint={`${formatNumber(monthlyCredits)} included per month`} /></CardContent></Card>
        <Card><CardContent><Stat label="Members" value={memberCount} hint={plan ? `of ${plan.max_members} seats` : undefined} /></CardContent></Card>
        <Card>
          <CardContent>
            <p className="text-xs text-fg-muted">Instagram</p>
            <div className="mt-2 flex items-center gap-2">
              <Icons.instagram className="text-fg-muted" />
              {social ? (
                <>
                  <span className="truncate text-sm font-medium text-fg">@{social.username ?? "unknown"}</span>
                  <Badge tone={SOCIAL_TONE[social.status]} className="capitalize">{social.status}</Badge>
                </>
              ) : (
                <Badge>Not connected</Badge>
              )}
            </div>
            <Link href="/settings/connections" className="mt-2 inline-block text-xs text-accent hover:text-accent-hover">
              {social ? "Manage connection" : canManage ? "Connect account" : "View connection"}
            </Link>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* Pending tasks */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Pending tasks</CardTitle>
            <CardDescription>
              {openTasks.length === 0 ? "You are all set." : `${openTasks.length} of ${tasks.length} remaining to finish setting up this workspace.`}
            </CardDescription>
          </CardHeader>
          <ul className="divide-y divide-line">
            {tasks.map((t) => (
              <li key={t.id}>
                <Link href={t.href} className="flex items-center gap-3 px-5 py-3 hover:bg-surface-2">
                  <span
                    aria-hidden
                    className={`grid size-5 shrink-0 place-items-center rounded-full border ${t.done ? "border-success bg-success/15 text-success" : "border-line-strong"}`}
                  >
                    {t.done && <Icons.check width={12} height={12} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm ${t.done ? "text-fg-subtle line-through" : "text-fg"}`}>{t.title}</span>
                    {!t.done && <span className="block text-xs text-fg-muted">{t.description}</span>}
                  </span>
                  <span className="sr-only">{t.done ? "Completed" : "Not completed"}</span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>

        {/* Usage overview */}
        <Card>
          <CardHeader>
            <CardTitle>Usage</CardTitle>
            <CardDescription>
              {subscription ? `Current period ends ${formatDate(subscription.current_period_end)}` : "No active period"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-baseline justify-between text-xs text-fg-muted">
              <span>Consumed this period</span>
              <span className="tabular-nums text-fg">{formatNumber(usedThisPeriod)}</span>
            </div>
            <div
              className="mt-2 h-2 overflow-hidden rounded-full bg-surface-3"
              role="progressbar"
              aria-label="Credits remaining"
              aria-valuemin={0}
              aria-valuemax={Math.max(monthlyCredits, balance)}
              aria-valuenow={balance}
            >
              <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (balance / Math.max(1, monthlyCredits, balance)) * 100)}%` }} />
            </div>
            <h3 className="mb-2 mt-5 text-xs font-medium text-fg-muted">Recent transactions</h3>
            {transactions.length === 0 ? (
              <p className="text-xs text-fg-subtle">No credit activity yet.</p>
            ) : (
              <ul className="space-y-2">
                {transactions.map((t) => (
                  <li key={t.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="min-w-0 truncate text-fg-muted">{t.reason}</span>
                    <span className={`shrink-0 tabular-nums ${t.amount > 0 ? "text-success" : "text-fg"}`}>
                      {t.amount > 0 ? "+" : ""}
                      {formatNumber(t.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/settings/billing" className="mt-4 inline-block text-xs text-accent hover:text-accent-hover">View full ledger</Link>
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        {/* Content production placeholders — honest, no fake numbers */}
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Content production</CardTitle>
            <CardDescription>Script Lab and Video Studio are live. Publish metrics appear once that module is released.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-3">
            <Link href="/script-lab" className="rounded-md border border-line p-4 hover:border-line-strong">
              <p className="text-xs text-fg-muted">Scripts</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">{scriptsRes.count ?? 0}</p>
              <Badge className="mt-3" tone="success">Available</Badge>
            </Link>
            <Link href="/video-studio" className="rounded-md border border-line p-4 hover:border-line-strong">
              <p className="text-xs text-fg-muted">Videos</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums text-fg">{videosRes.count ?? 0}</p>
              <Badge className="mt-3" tone="success">Available</Badge>
            </Link>
            {[
              { label: "Published posts", href: "/publish" },
            ].map((item) => (
              <Link key={item.label} href={item.href} className="rounded-md border border-dashed border-line p-4 hover:border-line-strong">
                <p className="text-xs text-fg-muted">{item.label}</p>
                <p className="mt-1 text-sm text-fg-subtle">Not available yet</p>
                <Badge className="mt-3">Coming soon</Badge>
              </Link>
            ))}
          </CardContent>
        </Card>

        {/* Activity */}
        <Card>
          <CardHeader>
            <CardTitle>Recent activity</CardTitle>
            <CardDescription>Audit trail for this workspace.</CardDescription>
          </CardHeader>
          <CardContent>
            {!canAudit ? (
              <EmptyState title="Visible to admins" description="Only owners and admins can view the workspace activity log." className="py-6" />
            ) : activity.length === 0 ? (
              <EmptyState title="No activity yet" className="py-6" />
            ) : (
              <ol className="space-y-3">
                {activity.map((a) => (
                  <li key={a.id} className="flex items-start gap-3 text-xs">
                    <span aria-hidden className="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                    <span className="min-w-0 flex-1 text-fg">{auditLabel(a.action)}</span>
                    <time dateTime={a.created_at} className="shrink-0 text-fg-subtle">{formatRelative(a.created_at)}</time>
                  </li>
                ))}
              </ol>
            )}
            {canAudit && activity.length > 0 && (
              <ButtonLink href="/settings/workspace#activity" variant="ghost" size="sm" className="mt-3 px-0">View all</ButtonLink>
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
