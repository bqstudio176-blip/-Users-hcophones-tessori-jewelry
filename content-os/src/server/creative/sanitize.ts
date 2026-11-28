/**
 * Prompt-injection defences for untrusted content (transcripts, titles,
 * notes, URLs, OCR'd on-screen text, user-entered fields).
 *
 * 1. Every untrusted item is wrapped in a delimited <untrusted_data> block
 *    with a stable id; the system prompt tells the model the content is data
 *    and that instructions inside it must never be followed.
 * 2. Delimiter forgery is neutralised: any text that could close or open our
 *    blocks is escaped, so a transcript cannot "end" the data section.
 * 3. Control characters are stripped and length is capped per item.
 * 4. Agents have no tools and must answer with a validated JSON schema, so an
 *    injected instruction cannot trigger an action — at worst it degrades
 *    one output, which validation and citation checks then reject.
 */
const TAG = /<\s*\/?\s*(untrusted_data|system|assistant|user|instructions?)\b[^>]*>/gi;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F​-‏‪-‮⁦-⁩]/g;

export function neutralize(text: string, maxChars = 4000): string {
  let t = (text ?? "").replace(CONTROL, "").replace(TAG, (m) => m.replace(/</g, "‹").replace(/>/g, "›"));
  t = t.replace(/```/g, "ˋˋˋ");
  if (t.length > maxChars) t = `${t.slice(0, maxChars)} […truncated]`;
  return t;
}

export function untrustedBlock(kind: string, id: string, text: string, maxChars = 4000): string {
  const safeKind = kind.replace(/[^a-z_]/gi, "");
  const safeId = id.replace(/[^A-Za-z0-9_:-]/g, "");
  return `<untrusted_data kind="${safeKind}" id="${safeId}">\n${neutralize(text, maxChars)}\n</untrusted_data>`;
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above) (instructions|prompts?)/i,
  /disregard (the )?(system|previous) (prompt|instructions)/i,
  /you are now\b/i,
  /new instructions?:/i,
  /reveal (your|the) (system )?prompt/i,
  /\bact as (an?|the) /i,
  /output (only|exactly)\b/i,
];

/** Flags suspicious instructions in untrusted text (for logging and UI notices; never executed). */
export function detectInjection(text: string): string[] {
  return INJECTION_PATTERNS.filter((p) => p.test(text ?? "")).map((p) => p.source);
}

/** Claims the product must never make. */
const FORBIDDEN_CLAIMS = /\b(guarantee[sd]?|guaranteed)\b[^.]{0,40}\b(viral|views|results|followers|sales)\b|\bwill (definitely |certainly )?go viral\b|\b100% (viral|success)\b/i;
export function containsForbiddenClaim(text: string): boolean {
  return FORBIDDEN_CLAIMS.test(text ?? "");
}
