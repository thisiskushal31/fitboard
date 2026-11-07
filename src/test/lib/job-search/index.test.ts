import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { json, stubFetch } from "@/lib/ai/test-http";
import { boardsearchV2LastPage, boardsearchV2Page } from "@/test/job-search-fixtures";

import { clearJobSearchCache } from "@/lib/job-search/cache";
import { postingDetails, searchPostings, testSource } from "@/lib/job-search/index";
import { EMPTY_QUERY } from "@/lib/job-search/search";
import { sourceCovers } from "@/lib/job-search/sources";

const query = { ...EMPTY_QUERY, keywords: "designer", country: "de" };
const ninja = { key: "ak_test", host: "openwebninja" as const };

beforeEach(() => {
  clearJobSearchCache();
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("searchPostings", () => {
  it("asks the source once per half hour for the same search and page", async () => {
    const requests = stubFetch(() => json(boardsearchV2Page));
    const first = await searchPostings("BOARDSEARCH", ninja, query);
    const again = await searchPostings("BOARDSEARCH", ninja, query);
    expect(again).toEqual(first);
    expect(requests).toHaveLength(1);

    await searchPostings("BOARDSEARCH", ninja, query, first.next);
    await searchPostings("BOARDSEARCH", ninja, { ...query, remoteOnly: true });
    expect(requests).toHaveLength(3);
  });

  it("doesn't keep failures", async () => {
    let status = 503;
    const requests = stubFetch(() => json(boardsearchV2LastPage, { status }));
    await expect(searchPostings("BOARDSEARCH", ninja, query)).rejects.toMatchObject({ problem: "unavailable" });
    status = 200;
    await expect(searchPostings("BOARDSEARCH", ninja, query)).resolves.toMatchObject({ next: null });
    expect(requests).toHaveLength(2);
  });

  it("logs problems with the source without the search, but not a wrong key", async () => {
    const log = vi.mocked(console.error);
    stubFetch(() => json({}, { status: 404 }));
    await expect(searchPostings("BOARDSEARCH", ninja, query)).rejects.toMatchObject({ problem: "changed" });
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain("[job search] Error: BOARDSEARCH: /jsearch/search-v2: HTTP 404");
    expect(String(log.mock.calls[0][0])).not.toContain("designer");

    stubFetch(() => json({}, { status: 401 }));
    await expect(searchPostings("BOARDSEARCH", ninja, { ...query, keywords: "other" })).rejects.toMatchObject({ problem: "key" });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("says when a source doesn't cover the country, before asking it", async () => {
    const requests = stubFetch(() => json(boardsearchV2Page));
    await expect(searchPostings("ARBEITSAGENTUR", {}, { ...query, country: "fr" })).rejects.toMatchObject({
      problem: "country",
      message: "Bundesagentur für Arbeit doesn't list jobs in France. Choose another country, or another source in Settings → Job search.",
    });
    expect(requests).toHaveLength(0);
    expect(sourceCovers("ADZUNA", "de")).toBe(true);
    expect(sourceCovers("ADZUNA", "jp")).toBe(false);
    expect(sourceCovers("BOARDSEARCH", "jp")).toBe(true);
    expect(sourceCovers("PUBLIC_BOARDS", "apac")).toBe(true);
    expect(sourceCovers("BOARDSEARCH", "apac")).toBe(false);
  });
});

describe("postingDetails", () => {
  it("returns a complete description as it is", async () => {
    const requests = stubFetch(() => json(boardsearchV2Page));
    const [posting] = (await searchPostings("BOARDSEARCH", ninja, query)).postings;
    expect(await postingDetails("BOARDSEARCH", ninja, posting)).toBe(posting.description);
    expect(requests).toHaveLength(1);
  });

  it("asks the source for the rest of an incomplete one, and keeps it", async () => {
    stubFetch(() => json(boardsearchV2Page));
    const [posting] = (await searchPostings("BOARDSEARCH", ninja, query)).postings;
    const partial = { ...posting, complete: false };
    expect(await postingDetails("BOARDSEARCH", ninja, partial)).toBe(posting.description);
    expect(await postingDetails("BOARDSEARCH", ninja, { ...partial, description: "" })).toBe(posting.description);
    expect(await postingDetails("BOARDSEARCH", ninja, { ...partial, externalId: "other", description: "" })).toBeNull();
  });
});

describe("testSource", () => {
  it("passes when the source answers", async () => {
    stubFetch(() => json(boardsearchV2LastPage));
    await expect(testSource("BOARDSEARCH", ninja)).resolves.toBeUndefined();
  });

  it("throws the problem when it doesn't", async () => {
    stubFetch(() => json({}, { status: 401 }));
    await expect(testSource("BOARDSEARCH", ninja)).rejects.toMatchObject({ problem: "key" });
  });
});
