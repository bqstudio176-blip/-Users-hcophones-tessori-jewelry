import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/session";

/** The proxy normally handles "/", this is a fallback. */
export default async function Home() {
  const user = await getSessionUser();
  redirect(user ? "/dashboard" : "/login");
}
