export function formatDate(value: string | Date, opts: Intl.DateTimeFormatOptions = { dateStyle: "medium" }) {
  return new Intl.DateTimeFormat("en-US", opts).format(new Date(value));
}

export function formatDateTime(value: string | Date) {
  return formatDate(value, { dateStyle: "medium", timeStyle: "short" });
}

export function formatRelative(value: string | Date, now = new Date()) {
  const diff = (new Date(value).getTime() - now.getTime()) / 1000;
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), "day");
  return formatDate(value);
}

export function formatNumber(n: number) {
  return new Intl.NumberFormat("en-US").format(n);
}

export function formatPrice(cents: number, currency = "usd") {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase(), maximumFractionDigits: 0 }).format(cents / 100);
}

/** Human labels for audit actions. Unknown actions fall back to the raw key. */
const AUDIT_LABELS: Record<string, string> = {
  "workspace.created": "Workspace created",
  "workspace.renamed": "Workspace renamed",
  "settings.updated": "Workspace settings updated",
  "invitation.created": "Invitation sent",
  "invitation.revoked": "Invitation revoked",
  "member.joined": "Member joined",
  "member.removed": "Member removed",
  "member.left": "Member left",
  "member.role_changed": "Member role changed",
  "social.connected": "Instagram connected",
  "social.disconnected": "Instagram disconnected",
  "social.status_changed": "Instagram status changed",
  "subscription.changed": "Subscription changed",
  "credits.adjusted": "Credits adjusted",
  "user.registered": "Account created",
};
export function auditLabel(action: string) {
  return AUDIT_LABELS[action] ?? action;
}
