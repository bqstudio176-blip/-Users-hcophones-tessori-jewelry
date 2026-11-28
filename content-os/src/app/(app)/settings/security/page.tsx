import type { Metadata } from "next";
import { ChangePasswordForm } from "@/components/app/settings-forms";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { getWorkspaceContext } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";
import { signOutEverywhere } from "@/server/actions/account";

export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage() {
  const { user } = await getWorkspaceContext();
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
          <CardDescription>You will need your current password.</CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Sessions</CardTitle>
          <CardDescription>Sign out of Content OS on every device, including this one.</CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div><dt className="text-xs text-fg-subtle">Email verified</dt><dd className="text-fg">{user.email_confirmed_at ? formatDateTime(user.email_confirmed_at) : "No"}</dd></div>
            <div><dt className="text-xs text-fg-subtle">Last sign-in</dt><dd className="text-fg">{user.last_sign_in_at ? formatDateTime(user.last_sign_in_at) : "—"}</dd></div>
          </dl>
        </CardContent>
        <CardFooter>
          <form action={signOutEverywhere}>
            <Button type="submit" variant="outline" className="text-danger">Sign out everywhere</Button>
          </form>
        </CardFooter>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Two-factor authentication</CardTitle>
          <CardDescription>Planned for a later phase. Not available yet.</CardDescription>
        </CardHeader>
      </Card>
    </>
  );
}
