import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { ResendVerificationForm } from "@/components/app/auth-forms";
import { getSessionUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Verify your email" };

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ email?: string }> }) {
  const user = await getSessionUser();
  if (user?.email_confirmed_at) redirect("/dashboard");
  const { email } = await searchParams;
  return (
    <>
      <h1 className="text-lg font-semibold text-fg">Check your inbox</h1>
      <p className="mb-6 mt-1 text-sm text-fg-muted">
        We sent a verification link{email || user?.email ? <> to <span className="text-fg">{email ?? user?.email}</span></> : null}.
        Open it on this device to activate your account.
      </p>
      <ResendVerificationForm email={email ?? user?.email ?? undefined} />
      <p className="mt-6 text-center text-xs text-fg-muted">
        <Link href="/login" className="font-medium text-accent hover:text-accent-hover">Back to sign in</Link>
      </p>
    </>
  );
}
