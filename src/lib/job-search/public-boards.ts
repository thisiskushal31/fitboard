import "server-only";

import type { JobSourceAdapter } from "./adapter";
import { crawlPublicBoards, filterPublicBoards, testPublicBoards, type CrawledPosting } from "./board-crawl";
import { jobSearchError } from "./errors";
import { POSTED_WITHIN, safeLink, type FoundPosting, type SearchQuery } from "./search";

const PAGE_SIZE = 20;

function postedWithinDays(value: SearchQuery["postedWithin"]): number | null {
  return POSTED_WITHIN.find((option) => option.value === value)?.days ?? null;
}

function toFound(posting: CrawledPosting): FoundPosting {
  return {
    source: "PUBLIC_BOARDS",
    externalId: posting.externalId,
    title: posting.title,
    company: posting.company,
    place: posting.place,
    remote: posting.remote,
    salary: posting.salary,
    postedAt: posting.postedAt,
    url: safeLink(posting.url).slice(0, 2000),
    via: posting.via,
    description: posting.description,
    complete: posting.description.length > 0,
  };
}

async function searchPage(query: SearchQuery, _credentials: Record<string, never>, next: string | null, context?: { signal?: AbortSignal }) {
  let crawled;
  try {
    crawled = await crawlPublicBoards(query.keywords, context?.signal);
  } catch (error) {
    throw jobSearchError("unavailable", "PUBLIC_BOARDS", { detail: error instanceof Error ? error.message : "crawl failed" });
  }
  const filtered = filterPublicBoards(crawled, {
    keywords: query.keywords,
    place: query.place,
    country: query.country,
    remoteOnly: query.remoteOnly,
    postedWithinDays: postedWithinDays(query.postedWithin),
  });
  const offset = next?.startsWith("offset:") ? Number(next.slice("offset:".length)) || 0 : 0;
  const postings = filtered.slice(offset, offset + PAGE_SIZE).map(toFound);
  const more = offset + PAGE_SIZE < filtered.length;
  return { postings, next: more ? `offset:${offset + PAGE_SIZE}` : null };
}

export const publicBoards: JobSourceAdapter<"PUBLIC_BOARDS"> = {
  source: "PUBLIC_BOARDS",
  search: searchPage,
  details: async (posting) => posting.description || null,
  test: async (_credentials, context) => {
    try {
      await testPublicBoards(context?.signal);
    } catch (error) {
      throw jobSearchError("unavailable", "PUBLIC_BOARDS", { detail: error instanceof Error ? error.message : "test failed" });
    }
  },
};
