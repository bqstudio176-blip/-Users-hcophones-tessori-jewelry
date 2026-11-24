import type { Metadata } from "next";
import Link from "next/link";
import { ForgotPasswordForm } from "@/components/app/auth-forms";

export const metadata: Metadata = { title: "Reset password" };

export default function ForgotPasswordPage() {
  return (
    <>
      <h1 className="text-lg font-semibold text-fg">Reset your password</h1>
      <p className="mb-6 mt-1 text-sm text-fg-muted">We will email you a secure link to choose a new password.</p>
      <ForgotPasswordForm />
      <p className="mt-6 text-center text-xs text-fg-muted">
        <Link href="/login" className="font-medium text-accent hover:text-accent-hover">Back to sign in</Link>
      </p>
    </>
  );
}
