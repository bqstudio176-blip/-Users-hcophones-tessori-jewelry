import type { Metadata } from "next";
import Link from "next/link";
import { CreateWorkspaceForm } from "@/components/app/workspace-forms";
import { getMemberships, requireVerifiedUser } from "@/lib/auth/session";
import { redirect } from "next/navigation";

export const metadata: Metadata = { title: "Create a workspace" };

export default async function OnboardingPage({ searchParams }: { searchParams: Promise<{ new?: string }> }) {
  const user = await requireVerifiedUser();
  const memberships = await getMemberships(user.id);
  const { new: creatingAnother } = await searchParams;
  if (memberships.length > 0 && !creatingAnother) redirect("/dashboard");

  return (
    <main id="main" className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-12">
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-96 w-[48rem] -translate-x-1/2 rounded-full bg-accent/20 blur-3xl" />
      <div className="relative w-full max-w-md">
        <p className="text-center text-xs font-medium uppercase tracking-widest text-accent">
          {memberships.length > 0 ? "New workspace" : "Step 1 of 1"}
        </p>
        <h1 className="mt-2 text-center text-2xl font-semibold tracking-tight text-fg">Create your workspace</h1>
        <p className="mt-2 text-center text-sm text-fg-muted">
          A workspace holds your team, settings, credits and one connected Instagram account.
        </p>
        <div className="mt-8 rounded-lg border border-line bg-surface p-6 shadow-elevated">
          <CreateWorkspaceForm />
        </div>
        {memberships.length > 0 && (
          <p className="mt-6 text-center text-xs">
            <Link href="/dashboard" className="text-fg-muted hover:text-fg">Cancel</Link>
          </p>
        )}
      </div>
    </main>
  );
}
