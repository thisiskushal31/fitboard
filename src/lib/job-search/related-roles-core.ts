/** Generic title glue — stripped so specialty words drive relatedness for any discipline. */
const GENERIC_ROLE_WORDS = new Set([
  "engineer",
  "engineering",
  "developer",
  "development",
  "software",
  "senior",
  "junior",
  "lead",
  "staff",
  "principal",
  "associate",
  "manager",
  "specialist",
  "consultant",
  "architect",
  "analyst",
  "full",
  "stack",
  "fullstack",
  "remote",
  "hybrid",
  "onsite",
  "contract",
  "internship",
  "intern",
  "role",
  "job",
  "jobs",
  "and",
  "or",
  "the",
  "for",
  "with",
]);

/** Tokenize the way an in-page find would scan titles. */
export function queryTokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#./]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1);
}

/** Specialty tokens left after dropping seniority / "engineer" glue. */
export function specialtyTokens(text: string): string[] {
  return queryTokens(text).filter((token) => !GENERIC_ROLE_WORDS.has(token) && token.length > 2);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-token hit so "engineer" does not match the word "Engineering". */
export function hayHasToken(hay: string, token: string): boolean {
  if (!token) return false;
  if (token.length <= 2) return hay.includes(token);
  return new RegExp(`(?:^|[^a-z0-9+#./])${escapeRegExp(token)}(?:[^a-z0-9+#./]|$)`, "i").test(hay);
}

/** True when `needle` appears in order inside `hay` (devops ⊂ devsecops). */
function isSubsequence(needle: string, hay: string): boolean {
  if (!needle || needle.length > hay.length) return false;
  let i = 0;
  for (const char of hay) {
    if (char === needle[i]) i += 1;
    if (i === needle.length) return true;
  }
  return false;
}

/**
 * Dynamic relatedness for specialty tokens — no hardcoded role lists.
 * Covers compound extensions (devops ↔ devsecops), shared *ops roots, and
 * containment for any discipline.
 */
export function specialtyTokensRelated(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.length >= 4 && b.includes(a)) return true;
  if (b.length >= 4 && a.includes(b)) return true;

  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  if (shorter.length >= 4 && isSubsequence(shorter, longer) && shorter.length / longer.length >= 0.45) {
    return true;
  }

  // Dynamic *ops extensions that share a stem (devops ↔ devsecops), not every *ops role.
  if (shorter.endsWith("ops") && longer.endsWith("ops") && shorter.length >= 4 && longer.length >= 4) {
    const shortStem = shorter.slice(0, -3);
    const longStem = longer.slice(0, -3);
    if (
      shortStem.length >= 2 &&
      (longStem.startsWith(shortStem) || shortStem.startsWith(longStem) || isSubsequence(shortStem, longStem))
    ) {
      return true;
    }
  }

  return false;
}

function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whether a listing title matches a search query via direct tokens or dynamic
 * specialty relatedness (works for DevOps, backend, design, sales, …).
 */
export function roleMatchesQuery(title: string, keywords: string, extra = "", relatedTerms: readonly string[] = []): boolean {
  const hay = normalizePhrase(`${title} ${extra}`);
  if (!hay) return false;

  const phrases = [keywords, ...relatedTerms].map(normalizePhrase).filter(Boolean);
  for (const phrase of phrases) {
    if (hay.includes(phrase)) return true;
    const tokens = queryTokens(phrase).filter((token) => !GENERIC_ROLE_WORDS.has(token) || phrase === keywords);
    if (tokens.length === 0) continue;
    if (tokens.some((token) => hayHasToken(hay, token))) {
      // Generic-only leftovers (e.g. lone "engineer") are too broad alone.
      const specialty = specialtyTokens(phrase);
      if (specialty.length === 0) {
        if (tokens.every((token) => hayHasToken(hay, token))) return true;
        continue;
      }
      if (specialty.some((token) => hayHasToken(hay, token))) return true;
    }

    const querySpecialty = specialtyTokens(phrase);
    const titleSpecialty = specialtyTokens(hay);
    if (
      querySpecialty.length > 0 &&
      titleSpecialty.some((titleToken) => querySpecialty.some((queryToken) => specialtyTokensRelated(queryToken, titleToken)))
    ) {
      return true;
    }
  }
  return false;
}
