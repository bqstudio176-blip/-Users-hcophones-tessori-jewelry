"use client";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";

export default function ScriptLabError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <ErrorState title="Script Lab could not complete that" description={error.message || "Please try again."} action={<Button variant="outline" onClick={reset}>Try again</Button>} />;
}
