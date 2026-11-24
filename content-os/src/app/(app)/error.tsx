"use client";

import { Button } from "@/components/ui/button";
import { ErrorState } from "@/components/ui/states";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <ErrorState
      title="We could not load this page"
      description={
        <>
          Please try again. If the problem persists, contact support{error.digest ? <> with reference <code className="kbd">{error.digest}</code></> : null}.
        </>
      }
      action={<Button variant="outline" onClick={reset}>Try again</Button>}
    />
  );
}
