import "server-only";

import { z } from "zod";

import { Creativity } from "@/generated/prisma/enums";
import { getAiProvider } from "@/lib/ai";

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

const RELATED_CACHE_TTL_MS = 30 * 60 * 1000;

type RelatedCacheEntry = { at: number; terms: string[] };

const relatedCache = new Map<string, RelatedCacheEntry>();

const relatedRolesSchema = z.object({
  /** Nearby job titles that usually need the same skills as the query. */
  relatedTitles: z.array(z.string().min(2).max(120)).max(24),
  /** Short skill / role tokens that should count as a match (not distant careers). */
  relatedTerms: z.array(z.string().min(2).max(60)).max(32),
});

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

/**
 * Ask the configured AI for nearby titles/terms for any role query.
 * Cached; failures are ignored so crawls still work offline / without a key.
 */
export async function expandRelatedRoleTerms(keywords: string, signal?: AbortSignal): Promise<string[]> {
  const key = normalizePhrase(keywords);
  if (!key) return [];

  const cached = relatedCache.get(key);
  if (cached && Date.now() - cached.at < RELATED_CACHE_TTL_MS) return cached.terms;

  let aiTerms: string[] = [];
  try {
    const provider = await getAiProvider();
    const answer = await provider.complete({
      system: `You expand a job-search query into nearby roles that share the same skill set.

Return only close variants and overlapping titles (e.g. "DevOps Engineer" → DevSecOps, SRE, Platform Engineer, Cloud Infrastructure; "Backend Engineer" → Platform API, Node.js Developer, Java Backend). Works for any discipline — engineering, design, product, sales, data, etc.

Do NOT include unrelated careers. Prefer short title phrases and skill tokens. Deduplicate.`,
      messages: [{ role: "user", content: JSON.stringify({ query: keywords }, null, 2) }],
      schema: relatedRolesSchema,
      schemaName: "related_roles",
      creativity: Creativity.FAITHFUL,
      effort: "low",
      signal,
      maxTokens: 700,
    });
    aiTerms = [...answer.relatedTitles, ...answer.relatedTerms]
      .map((term) => normalizePhrase(term))
      .filter((term) => term.length >= 2 && term !== key);
  } catch {
    // AI is optional for matching — compound heuristics still apply.
  }

  const terms = Array.from(new Set(aiTerms)).slice(0, 40);
  relatedCache.set(key, { at: Date.now(), terms });
  return terms;
}

/** Test helper: clear the related-role expansion cache. */
export function resetRelatedRoleCacheForTests(): void {
  relatedCache.clear();
}
