import { describe, expect, it } from "vitest";

import { boardsearch } from "@/lib/job-search/boardsearch";
import { EMPTY_QUERY } from "@/lib/job-search/search";

// Checks against the real Boardsearch API, skipped unless asked for. Each run
// spends two searches from the plan:
//
//   JOBS_LIVE=boardsearch BOARDSEARCH_TEST_KEY=… docker/bin/yarn vitest run src/test/lib/job-search/boardsearch.live.test.ts
//
// BOARDSEARCH_TEST_HOST=rapidapi checks a RapidAPI key instead.

const live = new Set((process.env.JOBS_LIVE ?? "").split(",").map((name) => name.trim()));
const key = process.env.BOARDSEARCH_TEST_KEY ?? "";
const host = process.env.BOARDSEARCH_TEST_HOST === "rapidapi" ? "rapidapi" : "openwebninja";

// Two searches, each of which may take up to BOARDSEARCH_TIMEOUT_MS.
describe.runIf(live.has("boardsearch") && key)("Boardsearch (live)", { timeout: 100_000 }, () => {
  it("finds postings near a place, with their text and a link, and a second page", async () => {
    const query = { ...EMPTY_QUERY, keywords: "software developer", place: "Hamburg", country: "de", radiusKm: 50 as const };
    const page = await boardsearch.search(query, { key, host }, null);
    expect(page.postings.length).toBeGreaterThan(0);
    for (const posting of page.postings) {
      expect(posting.title).not.toBe("");
      expect(posting.url).toMatch(/^https?:\/\//);
    }
    expect(page.postings.some((posting) => posting.complete)).toBe(true);
    expect(page.next).not.toBeNull();

    const next = await boardsearch.search(query, { key, host }, page.next);
    expect(next.postings.length).toBeGreaterThan(0);
  });
});
