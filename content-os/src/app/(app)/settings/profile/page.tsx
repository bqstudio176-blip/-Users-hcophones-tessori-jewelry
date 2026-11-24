import type { Metadata } from "next";
import { ProfileForm } from "@/components/app/settings-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getWorkspaceContext } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Profile" };

export default async function ProfilePage() {
  const { profile } = await getWorkspaceContext();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Profile</CardTitle>
        <CardDescription>How you appear to teammates across workspaces.</CardDescription>
      </CardHeader>
      <CardContent>
        <ProfileForm fullName={profile.full_name ?? ""} avatarUrl={profile.avatar_url ?? ""} email={profile.email} />
      </CardContent>
    </Card>
  );
}
