import type { Metadata } from "next";
import Link from "next/link";
import { LoginForm } from "@/components/app/auth-forms";
import { Alert } from "@/components/ui/alert";
import { safeNextPath } from "@/lib/auth/route-access";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const { next, error } = await searchParams;
  return (
    <>
      <h1 className="text-lg font-semibold text-fg">Welcome back</h1>
      <p className="mb-6 mt-1 text-sm text-fg-muted">Sign in to your Content OS workspace.</p>
      {error === "link_invalid" && (
        <Alert tone="warning" className="mb-4">That link is invalid or has expired. Request a new one.</Alert>
      )}
      <LoginForm next={next ? safeNextPath(next) : undefined} />
      <p className="mt-6 text-center text-xs text-fg-muted">
        New to Content OS? <Link href="/register" className="font-medium text-accent hover:text-accent-hover">Create an account</Link>
      </p>
    </>
  );
}
