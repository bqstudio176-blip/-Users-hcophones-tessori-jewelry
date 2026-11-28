"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Field, Input } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import { IDLE } from "@/lib/types";
import { requestPasswordReset, resendVerification, resetPassword, signIn, signUp } from "@/server/actions/auth";

const PASSWORD_HINT = "10+ characters with uppercase, lowercase and a number.";

export function LoginForm({ next }: { next?: string }) {
  const [state, action] = useActionState(signIn, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {next && <input type="hidden" name="next" value={next} />}
      <Field label="Email" name="email" error={fe.email}>
        <Input name="email" type="email" autoComplete="email" required error={fe.email} />
      </Field>
      <Field label="Password" name="password" error={fe.password}>
        <Input name="password" type="password" autoComplete="current-password" required error={fe.password} />
      </Field>
      <div className="flex justify-end">
        <Link href="/forgot-password" className="text-xs text-fg-muted hover:text-fg">Forgot password?</Link>
      </div>
      <SubmitButton className="w-full" pendingLabel="Signing in…">Sign in</SubmitButton>
    </form>
  );
}

export function RegisterForm() {
  const [state, action] = useActionState(signUp, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field label="Full name" name="fullName" error={fe.fullName}>
        <Input name="fullName" autoComplete="name" required error={fe.fullName} />
      </Field>
      <Field label="Work email" name="email" error={fe.email}>
        <Input name="email" type="email" autoComplete="email" required error={fe.email} />
      </Field>
      <Field label="Password" name="password" error={fe.password} hint={PASSWORD_HINT}>
        <Input name="password" type="password" autoComplete="new-password" required minLength={10} error={fe.password} hasHint />
      </Field>
      <SubmitButton className="w-full" pendingLabel="Creating account…">Create account</SubmitButton>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action] = useActionState(requestPasswordReset, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field label="Email" name="email" error={fe.email}>
        <Input name="email" type="email" autoComplete="email" required error={fe.email} />
      </Field>
      <SubmitButton className="w-full" pendingLabel="Sending…">Send reset link</SubmitButton>
    </form>
  );
}

export function ResetPasswordForm() {
  const [state, action] = useActionState(resetPassword, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field label="New password" name="password" error={fe.password} hint={PASSWORD_HINT}>
        <Input name="password" type="password" autoComplete="new-password" required error={fe.password} hasHint />
      </Field>
      <Field label="Confirm new password" name="confirmPassword" error={fe.confirmPassword}>
        <Input name="confirmPassword" type="password" autoComplete="new-password" required error={fe.confirmPassword} />
      </Field>
      <SubmitButton className="w-full" pendingLabel="Updating…">Update password</SubmitButton>
    </form>
  );
}

export function ResendVerificationForm({ email }: { email?: string }) {
  const [state, action] = useActionState(resendVerification, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-3" noValidate>
      <FormMessage state={state} />
      <Field label="Email" name="email" error={fe.email}>
        <Input name="email" type="email" defaultValue={email} autoComplete="email" required error={fe.email} />
      </Field>
      <SubmitButton variant="outline" className="w-full" pendingLabel="Sending…">Resend verification email</SubmitButton>
    </form>
  );
}
