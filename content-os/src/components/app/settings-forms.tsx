"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/field";
import { FormMessage } from "@/components/ui/form-message";
import { SubmitButton } from "@/components/ui/submit-button";
import type { WorkspaceRole } from "@/lib/auth/permissions";
import { IDLE, type WorkspaceSettings } from "@/lib/types";
import type { Preferences } from "@/lib/validation";
import { changePassword, updatePreferences, updateProfile } from "@/server/actions/account";
import { adjustCredits } from "@/server/actions/admin";
import { inviteMember, updateWorkspaceSettings } from "@/server/actions/workspace";

export function ProfileForm({ fullName, avatarUrl, email }: { fullName: string; avatarUrl: string; email: string }) {
  const [state, action] = useActionState(updateProfile, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <Field label="Email" name="email" hint="Email changes are not available in this phase.">
        <Input name="email" value={email} readOnly disabled hasHint />
      </Field>
      <Field label="Full name" name="fullName" error={fe.fullName}>
        <Input name="fullName" defaultValue={fullName} required maxLength={120} autoComplete="name" error={fe.fullName} />
      </Field>
      <Field label="Avatar URL" name="avatarUrl" error={fe.avatarUrl} hint="Optional. An https:// image URL.">
        <Input name="avatarUrl" type="url" defaultValue={avatarUrl} placeholder="https://" error={fe.avatarUrl} hasHint />
      </Field>
      <div className="flex justify-end">
        <SubmitButton pendingLabel="Saving…">Save profile</SubmitButton>
      </div>
    </form>
  );
}

const LANGUAGES = [
  ["en", "English"],
  ["es", "Spanish"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
] as const;

export function WorkspaceSettingsForm({
  name,
  settings,
  timezones,
  canEdit,
}: {
  name: string;
  settings: WorkspaceSettings;
  timezones: string[];
  canEdit: boolean;
}) {
  const [state, action] = useActionState(updateWorkspaceSettings, IDLE);
  const fe = state.fieldErrors ?? {};
  const tzList = timezones.includes(settings.timezone) ? timezones : [settings.timezone, ...timezones];
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <fieldset disabled={!canEdit} className="space-y-4 disabled:opacity-80">
        <Field label="Workspace name" name="name" error={fe.name}>
          <Input name="name" defaultValue={name} required maxLength={80} error={fe.name} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Timezone" name="timezone" error={fe.timezone}>
            <Select name="timezone" defaultValue={settings.timezone} error={fe.timezone}>
              {tzList.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </Select>
          </Field>
          <Field label="Default content language" name="defaultLanguage" error={fe.defaultLanguage}>
            <Select name="defaultLanguage" defaultValue={settings.default_language} error={fe.defaultLanguage}>
              {LANGUAGES.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Content niche" name="contentNiche" error={fe.contentNiche} hint="e.g. Home fitness for busy parents">
          <Input name="contentNiche" defaultValue={settings.content_niche ?? ""} maxLength={120} error={fe.contentNiche} hasHint />
        </Field>
        <Field label="Brand voice" name="brandVoice" error={fe.brandVoice} hint="Tone, vocabulary, words to avoid.">
          <Textarea name="brandVoice" defaultValue={settings.brand_voice ?? ""} maxLength={2000} error={fe.brandVoice} hasHint />
        </Field>
        <Field label="Target audience" name="targetAudience" error={fe.targetAudience}>
          <Textarea name="targetAudience" defaultValue={settings.target_audience ?? ""} maxLength={2000} error={fe.targetAudience} />
        </Field>
      </fieldset>
      {canEdit && (
        <div className="flex justify-end">
          <SubmitButton pendingLabel="Saving…">Save changes</SubmitButton>
        </div>
      )}
    </form>
  );
}

export function InviteMemberForm({ roles }: { roles: Exclude<WorkspaceRole, "owner">[] }) {
  const [state, action] = useActionState(inviteMember, IDLE);
  const [copied, setCopied] = useState(false);
  const fe = state.fieldErrors ?? {};
  const inviteUrl = state.data?.inviteUrl;
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      {inviteUrl && (
        <div className="flex gap-2">
          <Input name="inviteUrl" value={inviteUrl} readOnly aria-label="Invitation link" className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(inviteUrl);
                setCopied(true);
              } catch {
                setCopied(false);
              }
            }}
          >
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto] sm:items-end">
        <Field label="Email address" name="email" error={fe.email}>
          <Input name="email" type="email" required placeholder="teammate@company.com" error={fe.email} />
        </Field>
        <Field label="Role" name="role" error={fe.role}>
          <Select name="role" defaultValue="member" error={fe.role}>
            {roles.map((r) => <option key={r} value={r}>{r === "admin" ? "Admin" : "Member"}</option>)}
          </Select>
        </Field>
        <SubmitButton pendingLabel="Inviting…">Create invite</SubmitButton>
      </div>
    </form>
  );
}

export function ChangePasswordForm() {
  const [state, action] = useActionState(changePassword, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate key={state.status === "success" ? "reset" : "form"}>
      <FormMessage state={state} />
      <Field label="Current password" name="currentPassword" error={fe.currentPassword}>
        <Input name="currentPassword" type="password" autoComplete="current-password" required error={fe.currentPassword} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="New password" name="password" error={fe.password} hint="10+ characters, mixed case and a number.">
          <Input name="password" type="password" autoComplete="new-password" required error={fe.password} hasHint />
        </Field>
        <Field label="Confirm new password" name="confirmPassword" error={fe.confirmPassword}>
          <Input name="confirmPassword" type="password" autoComplete="new-password" required error={fe.confirmPassword} />
        </Field>
      </div>
      <div className="flex justify-end">
        <SubmitButton pendingLabel="Updating…">Update password</SubmitButton>
      </div>
    </form>
  );
}

export function PreferencesForm({ preferences }: { preferences: Preferences }) {
  const [state, action] = useActionState(updatePreferences, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-5" noValidate>
      <FormMessage state={state} />
      <fieldset>
        <legend className="text-sm font-medium text-fg">Theme</legend>
        <p className="mb-3 text-xs text-fg-subtle">Content OS is designed dark-first.</p>
        <div className="grid gap-2 sm:grid-cols-3">
          {(["dark", "light", "system"] as const).map((t) => (
            <label key={t} className="flex cursor-pointer items-center gap-2 rounded-md border border-line bg-surface-2 px-3 py-2.5 text-sm capitalize has-[:checked]:border-accent has-[:checked]:bg-accent/10">
              <input type="radio" name="theme" value={t} defaultChecked={preferences.theme === t} className="accent-[rgb(var(--color-accent))]" />
              {t}
            </label>
          ))}
        </div>
        {fe.theme && <p className="mt-1 text-xs text-danger">{fe.theme}</p>}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-fg">Email</legend>
        <p className="-mt-1 mb-2 text-xs text-fg-subtle">Saved now; product emails will honour these when email delivery launches.</p>
        <Checkbox name="emailProductUpdates" label="Product updates" description="New modules and important changes." defaultChecked={preferences.emailProductUpdates} />
        <Checkbox name="emailWeeklySummary" label="Weekly summary" description="A digest of workspace activity." defaultChecked={preferences.emailWeeklySummary} />
      </fieldset>
      <div className="flex justify-end">
        <SubmitButton pendingLabel="Saving…">Save preferences</SubmitButton>
      </div>
    </form>
  );
}

export function AdjustCreditsForm({ workspaceId }: { workspaceId: string }) {
  const [state, action] = useActionState(adjustCredits, IDLE);
  const fe = state.fieldErrors ?? {};
  return (
    <form action={action} className="space-y-4" noValidate>
      <FormMessage state={state} />
      <input type="hidden" name="workspaceId" value={workspaceId} />
      <div className="grid gap-3 sm:grid-cols-[8rem_1fr]">
        <Field label="Amount" name="amount" error={fe.amount} hint="Negative to deduct.">
          <Input name="amount" type="number" step={1} required error={fe.amount} hasHint />
        </Field>
        <Field label="Reason" name="reason" error={fe.reason} hint="Recorded in the ledger and audit log.">
          <Input name="reason" required maxLength={200} error={fe.reason} hasHint />
        </Field>
      </div>
      <div className="flex justify-end">
        <SubmitButton pendingLabel="Recording…">Record adjustment</SubmitButton>
      </div>
    </form>
  );
}
