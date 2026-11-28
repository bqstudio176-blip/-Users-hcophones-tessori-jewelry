import type { Metadata } from "next";
import Link from "next/link";
import { RegisterForm } from "@/components/app/auth-forms";

export const metadata: Metadata = { title: "Create account" };

export default function RegisterPage() {
  return (
    <>
      <h1 className="text-lg font-semibold text-fg">Create your account</h1>
      <p className="mb-6 mt-1 text-sm text-fg-muted">You will verify your email before creating a workspace.</p>
      <RegisterForm />
      <p className="mt-6 text-center text-xs text-fg-muted">
        Already have an account? <Link href="/login" className="font-medium text-accent hover:text-accent-hover">Sign in</Link>
      </p>
    </>
  );
}
