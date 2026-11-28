import type { Metadata } from "next";
import { EMPTY_RULE, RuleForm } from "@/components/creative/rule-form";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/states";
import { getWorkspaceContext } from "@/lib/auth/session";

export const metadata: Metadata = { title: "New creative rule" };

export default async function NewRulePage() {
  await getWorkspaceContext();
  return (
    <>
      <PageHeader title="New workspace rule" description="Workspace rules start as drafts and are only used by the agents after an owner or admin approves them." />
      <Card><CardContent className="pt-4"><RuleForm values={EMPTY_RULE} /></CardContent></Card>
    </>
  );
}
