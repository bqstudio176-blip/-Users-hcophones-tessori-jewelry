import type { ActionState } from "@/lib/types";
import { Alert } from "./alert";

export function FormMessage({ state }: { state: ActionState }) {
  if (!state.message) return null;
  return <Alert tone={state.status === "error" ? "danger" : "success"}>{state.message}</Alert>;
}
