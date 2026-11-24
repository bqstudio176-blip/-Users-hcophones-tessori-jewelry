/** Maps Postgres/PostgREST errors raised by our RPCs to user-facing text. */
export function dbErrorMessage(error: { code?: string; message?: string } | null | undefined, fallback = "Something went wrong. Please try again."): string {
  if (!error) return fallback;
  const msg = error.message ?? "";
  switch (error.code) {
    case "42501":
      if (/verified/.test(msg)) return "Verify your email address first.";
      if (/only the owner/.test(msg)) return "Only the workspace owner can do that.";
      if (/owner (role )?cannot/.test(msg)) return "The workspace owner cannot be changed or removed.";
      return "You do not have permission to do that.";
    case "23505":
      if (/slug/.test(msg)) return "That workspace URL is already taken.";
      if (/already a member/.test(msg)) return "That person is already a member.";
      if (/invitations_open/.test(msg)) return "There is already a pending invitation for that email.";
      if (/social_accounts_one_per_workspace/.test(msg)) return "This workspace already has a connected account.";
      return "That already exists.";
    case "23514":
      return "Some values are invalid.";
    case "54000":
      if (/member limit/.test(msg)) return "Your plan's member limit has been reached.";
      if (/workspace limit/.test(msg)) return "You have reached the maximum number of workspaces.";
      return "A limit has been reached.";
    case "22023":
      return msg ? msg.charAt(0).toUpperCase() + msg.slice(1) + "." : fallback;
    case "P0001":
      if (/insufficient credits/.test(msg)) return "Not enough credits.";
      return fallback;
    case "P0002":
      return "Not found.";
    default:
      return fallback;
  }
}
