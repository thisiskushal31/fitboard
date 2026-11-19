import "server-only";

import { z } from "zod";

import { Creativity } from "@/generated/prisma/enums";
import { getAiProvider } from "@/lib/ai";
import { extractJson } from "@/lib/ai/provider";

export {
  hayHasToken,
  queryTokens,
  roleMatchesQuery,
  specialtyTokens,
  specialtyTokensRelated,
} from "./related-roles-core";

const RELATED_CACHE_TTL_MS = 30 * 60 * 1000;

type RelatedCacheEntry = { at: number; terms: string[] };

const relatedCache = new Map<string, RelatedCacheEntry>();

const relatedRolesSchema = z.object({
  /** Nearby job titles that usually need the same skills as the query. */
  relatedTitles: z.array(z.string().min(2).max(120)).max(24),
  /** Short skill / role tokens that should count as a match (not distant careers). */
  relatedTerms: z.array(z.string().min(2).max(60)).max(32),
});

function normalizePhrase(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

const RELATED_SYSTEM = `You expand a job-search query into nearby roles that share the same skill set.

Return only close variants and overlapping titles (e.g. "DevOps Engineer" → DevSecOps, SRE, Platform Engineer, Cloud Infrastructure; "Backend Engineer" → Platform API, Node.js Developer, Java Backend). Works for any discipline — engineering, design, product, sales, data, etc.

Do NOT include unrelated careers. Prefer short title phrases and skill tokens. Deduplicate.
Reply with only this JSON object: {"relatedTitles":["..."],"relatedTerms":["..."]}`;

/** Pull related titles/terms from structured JSON or a plain list when the model ignored the schema. */
function termsFromRelatedAnswer(raw: string, queryKey: string): string[] {
  try {
    const parsed = relatedRolesSchema.safeParse(extractJson(raw));
    if (parsed.success) {
      return [...parsed.data.relatedTitles, ...parsed.data.relatedTerms]
        .map((term) => normalizePhrase(term))
        .filter((term) => term.length >= 2 && term !== queryKey);
    }
  } catch {
    // Fall through to a plain list.
  }
  return raw
    .split(/[\n,;•|]|(?:\s+-\s+)/)
    .map((part) => normalizePhrase(part.replace(/^[-*\d.)\s]+/, "").replace(/^["']|["']$/g, "")))
    .filter((term) => term.length >= 2 && term.length <= 80 && term !== queryKey && !/related|title|term|json|schema|query/i.test(term));
}

/**
 * Ask the configured AI for nearby titles/terms for any role query.
 * Cached; failures are ignored so crawls still work offline / without a key.
 * Cursor (and similar) agents often return prose instead of schema JSON — a
 * second plain-text ask avoids the loud "related_roles … not JSON" loop.
 */
export async function expandRelatedRoleTerms(keywords: string, signal?: AbortSignal): Promise<string[]> {
  const key = normalizePhrase(keywords);
  if (!key) return [];

  const cached = relatedCache.get(key);
  if (cached && Date.now() - cached.at < RELATED_CACHE_TTL_MS) return cached.terms;

  let aiTerms: string[] = [];
  try {
    const provider = await getAiProvider();
    const user = JSON.stringify({ query: keywords }, null, 2);
    // Cursor cloud agents often ignore JSON schemas and return prose; asking
    // without `schema` avoids the "related_roles … not JSON" double-retry log.
    if (provider.kind === "CURSOR") {
      const raw = await provider.complete({
        system: RELATED_SYSTEM,
        messages: [{ role: "user", content: user }],
        creativity: Creativity.FAITHFUL,
        effort: "low",
        signal,
        maxTokens: 700,
      });
      aiTerms = termsFromRelatedAnswer(raw, key);
    } else {
      try {
        const answer = await provider.complete({
          system: RELATED_SYSTEM,
          messages: [{ role: "user", content: user }],
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
        const raw = await provider.complete({
          system: RELATED_SYSTEM,
          messages: [{ role: "user", content: user }],
          creativity: Creativity.FAITHFUL,
          effort: "low",
          signal,
          maxTokens: 700,
        });
        aiTerms = termsFromRelatedAnswer(raw, key);
      }
    }
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
