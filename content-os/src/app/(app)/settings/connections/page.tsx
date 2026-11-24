import type { Metadata } from "next";
import { Alert } from "@/components/ui/alert";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button, buttonClasses } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Icons } from "@/components/ui/icons";
import { can } from "@/lib/auth/permissions";
import { getWorkspaceContext } from "@/lib/auth/session";
import { serverEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/format";
import { INSTAGRAM_SCOPES } from "@/lib/integrations/instagram";
import { createClient } from "@/lib/supabase/server";
import type { SocialAccount } from "@/lib/types";
import { disconnectSocialAccount } from "@/server/actions/social";

export const metadata: Metadata = { title: "Connections" };

const ERRORS: Record<string, string> = {
  not_configured: "Instagram integration is not configured on this deployment yet (missing Meta app credentials or encryption keys).",
  already_connected: "This workspace already has a connected Instagram account. Disconnect it first.",
  forbidden: "Only owners and admins can manage connections.",
  denied: "Instagram authorization was cancelled.",
  invalid_state: "The connection attempt expired or could not be verified. Please try again.",
  exchange_failed: "Instagram rejected the authorization. Please try again.",
  save_failed: "We could not save the connection. Please try again.",
};

const TONE: Record<SocialAccount["status"], BadgeTone> = {
  connected: "success",
  pending: "info",
  expired: "warning",
  revoked: "warning",
  error: "danger",
};

export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ error?: string; connected?: string }> }) {
  const ctx = await getWorkspaceContext();
  const { error, connected } = await searchParams;
  const supabase = await createClient();
  const { data, error: loadError } = await supabase.from("social_accounts").select("*").eq("workspace_id", ctx.workspace.id).maybeSingle();
  if (loadError) throw new Error("Could not load connection status");

  const account = data as SocialAccount | null;
  const canManage = can(ctx.role, "social.manage");
  const configured = serverEnv.instagram.configured;

  return (
    <>
      {error && <Alert tone="danger">{ERRORS[error] ?? "Something went wrong with the connection."}</Alert>}
      {connected && <Alert tone="success">Instagram account connected.</Alert>}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="grid size-10 place-items-center rounded-lg bg-gradient-to-br from-[#f58529] via-[#dd2a7b] to-[#8134af] text-white">
                <Icons.instagram width={20} height={20} />
              </span>
              <div>
                <CardTitle>Instagram</CardTitle>
                <CardDescription>Business or Creator account · one per workspace</CardDescription>
              </div>
            </div>
            {account ? <Badge tone={TONE[account.status]} className="capitalize">{account.status}</Badge> : <Badge>Not connected</Badge>}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {account ? (
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div><dt className="text-xs text-fg-subtle">Account</dt><dd className="text-fg">@{account.username ?? "unknown"}{account.display_name ? ` · ${account.display_name}` : ""}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Type</dt><dd className="capitalize text-fg">{account.account_type?.toLowerCase().replace("_", " ") ?? "—"}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Connected</dt><dd className="text-fg">{account.connected_at ? formatDateTime(account.connected_at) : "—"}</dd></div>
              <div><dt className="text-xs text-fg-subtle">Permissions</dt><dd className="text-fg">{account.scopes.join(", ") || "—"}</dd></div>
              {account.last_error && <div className="sm:col-span-2"><dt className="text-xs text-fg-subtle">Last error</dt><dd className="text-danger">{account.last_error}</dd></div>}
            </dl>
          ) : (
            <p className="text-sm text-fg-muted">
              Connect the Instagram account this workspace creates content for. Content OS will request read-only profile access
              (<code className="kbd">{INSTAGRAM_SCOPES.join(", ")}</code>). Publishing permissions will be requested when the Publish module launches.
            </p>
          )}
          {!configured && !account && (
            <Alert tone="warning" title="Not available on this deployment">
              The Instagram app credentials have not been configured. An operator must set the Meta app variables documented in the README.
            </Alert>
          )}
          {!canManage && <p className="text-xs text-fg-subtle">Only owners and admins can connect or disconnect accounts.</p>}
          <p className="text-xs text-fg-subtle">
            Access tokens are encrypted with AES-256-GCM before storage and are never sent to the browser.
          </p>
        </CardContent>
        {canManage && (
          <CardFooter>
            {account ? (
              <form action={disconnectSocialAccount}>
                <Button type="submit" variant="outline" className="text-danger">Disconnect</Button>
              </form>
            ) : configured ? (
              // Plain link: the route handler performs the redirect to Instagram.
              <a href="/api/connections/instagram/start" className={buttonClasses("primary")}>Connect Instagram</a>
            ) : (
              <Button disabled aria-disabled>Connect Instagram</Button>
            )}
          </CardFooter>
        )}
      </Card>
    </>
  );
}
