/**
 * Deterministic originality check: share of the script's spoken word
 * 8-grams that also appear in a reference transcript. Used to block scripts
 * that reproduce third-party transcripts and reported in quality checks.
 */
function tokens(text: string): string[] {
  return (text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9']+/g) ?? []);
}

function ngrams(words: string[], n: number): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + n <= words.length; i++) out.add(words.slice(i, i + n).join(" "));
  return out;
}

export interface OverlapResult {
  ratio: number; // 0–1 share of script n-grams found in the source
  sourceId: string | null;
  sharedSamples: string[];
}

export const ORIGINALITY_MAX_OVERLAP = 0.15;

export function maxTranscriptOverlap(scriptText: string, sources: { id: string; text: string }[], n = 8): OverlapResult {
  const scriptGrams = ngrams(tokens(scriptText), n);
  if (scriptGrams.size === 0) return { ratio: 0, sourceId: null, sharedSamples: [] };
  let best: OverlapResult = { ratio: 0, sourceId: null, sharedSamples: [] };
  for (const s of sources) {
    const sourceGrams = ngrams(tokens(s.text), n);
    const shared = [...scriptGrams].filter((g) => sourceGrams.has(g));
    const ratio = shared.length / scriptGrams.size;
    if (ratio > best.ratio) best = { ratio: Math.round(ratio * 1000) / 1000, sourceId: s.id, sharedSamples: shared.slice(0, 3) };
  }
  return best;
}
