import "server-only";

import { filterByCompany } from "./company-filter";
import { expandRelatedRoleTerms, roleMatchesQuery } from "./related-roles";
import type { FoundPosting, JobSource, SearchQuery } from "./search";

/**
 * Post-filter a page of found postings by selected company.
 * PUBLIC_BOARDS also re-applies flexible title matching (idempotent with the crawl filter).
 * Other sources already ranked the query themselves — title filtering would drop
 * legitimate nearby roles they returned.
 */
export async function refineFoundPostings(
  postings: readonly FoundPosting[],
  query: SearchQuery,
  source?: JobSource,
  signal?: AbortSignal,
): Promise<FoundPosting[]> {
  const next = filterByCompany(postings, query.company);
  const keywords = query.keywords.trim();
  if (!keywords || source !== "PUBLIC_BOARDS") return next;
  const related = await expandRelatedRoleTerms(keywords, signal).catch(() => [] as string[]);
  return next.filter((posting) =>
    roleMatchesQuery(posting.title, keywords, `${posting.company} ${posting.place} ${posting.description}`.slice(0, 2500), related),
  );
}
