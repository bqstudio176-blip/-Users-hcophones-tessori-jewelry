import type { Metadata } from "next";
import Link from "next/link";
import { ResetPasswordForm } from "@/components/app/auth-forms";
import { Alert } from "@/components/ui/alert";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Choose a new password" };

export default async function ResetPasswordPage() {
  // Reached through the recovery email link, which establishes a session.
  const user = await getSessionUser();
  return (
    <>
      <h1 className="text-lg font-semibold text-fg">Choose a new password</h1>
      {user ? (
        <>
          <p className="mb-6 mt-1 text-sm text-fg-muted">For {user.email}</p>
          <ResetPasswordForm />
        </>
      ) : (
        <div className="mt-4 space-y-4">
          <Alert tone="warning">This reset link is invalid or has expired.</Alert>
          <Link href="/forgot-password" className="text-sm font-medium text-accent hover:text-accent-hover">Request a new link</Link>
        </div>
      )}
    </>
  );
}
