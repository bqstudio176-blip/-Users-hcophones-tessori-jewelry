import type { Metadata } from "next";
import { PreferencesForm } from "@/components/app/settings-forms";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getWorkspaceContext } from "@/lib/auth/session";
import { parsePreferences } from "@/lib/validation";

export const metadata: Metadata = { title: "Preferences" };

export default async function PreferencesPage() {
  const { profile } = await getWorkspaceContext();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preferences</CardTitle>
        <CardDescription>Personal settings that follow you across workspaces.</CardDescription>
      </CardHeader>
      <CardContent>
        <PreferencesForm preferences={parsePreferences(profile.preferences)} />
      </CardContent>
    </Card>
  );
}
