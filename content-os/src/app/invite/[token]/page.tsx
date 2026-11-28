import type { Metadata } from "next";
import Link from "next/link";
import { AcceptInvitationForm } from "@/components/app/workspace-forms";
import { Alert } from "@/components/ui/alert";
import { ButtonLink } from "@/components/ui/button";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Join workspace" };

export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await getSessionUser();
  const valid = /^[0-9a-f]{64}$/.test(token);
  const here = `/invite/${token}`;

  return (
    <main id="main" className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 shadow-elevated">
        <h1 className="text-lg font-semibold text-fg">You have been invited</h1>
        {!valid ? (
          <Alert tone="danger" className="mt-4">This invitation link is malformed.</Alert>
        ) : !user ? (
          <>
            <p className="mt-1 text-sm text-fg-muted">Sign in or create an account with the email address the invitation was sent to.</p>
            <div className="mt-6 flex flex-col gap-2">
              <ButtonLink href={`/login?next=${encodeURIComponent(here)}`}>Sign in to accept</ButtonLink>
              <ButtonLink href="/register" variant="outline">Create an account</ButtonLink>
            </div>
            <p className="mt-4 text-xs text-fg-subtle">After verifying a new account, open this link again.</p>
          </>
        ) : !user.email_confirmed_at ? (
          <Alert tone="warning" className="mt-4">
            Verify your email address first, then reopen this link. <Link href="/verify-email" className="underline">Resend verification</Link>
          </Alert>
        ) : (
          <>
            <p className="mb-6 mt-1 text-sm text-fg-muted">
              Signed in as <span className="text-fg">{user.email}</span>. The invitation must have been sent to this address.
            </p>
            <AcceptInvitationForm token={token} />
          </>
        )}
      </div>
    </main>
  );
}
