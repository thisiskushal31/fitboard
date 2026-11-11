import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "@/lib/core/prisma";
import {
  clearAllBoardCrawls,
  clearResolvedBoardCrawls,
  deleteBoardCrawlResult,
  listBoardCrawlResults,
  markBoardCrawlResolved,
  recordBoardCrawl,
  syncBoardCrawlWithCatalog,
} from "@/lib/job-search/crawl-results";

describe("board crawl results", () => {
  afterEach(async () => {
    await prisma.boardCrawlResult.deleteMany();
  });

  it("upserts by URL, lists problems, and supports resolve/delete", async () => {
    await recordBoardCrawl({
      url: "https://jobs.example.com/careers",
      company: "Example Co",
      status: "empty",
      hitCount: 0,
      samples: [],
      detail: "No search field was found on this careers URL.",
      keywords: "Backend Engineer",
      place: "",
      country: "in",
      method: "browser",
      durationMs: 1200,
      openProblem: true,
    });
    await recordBoardCrawl({
      url: "https://jobs.example.com/careers",
      company: "Example Co",
      status: "ok",
      hitCount: 2,
      samples: ["Backend Engineer", "Senior Backend Engineer"],
      detail: "Search bar returned 2 listings.",
      keywords: "Backend Engineer",
      place: "",
      country: "in",
      method: "browser",
      durationMs: 900,
    });
    await recordBoardCrawl({
      url: "https://careers.other.example/jobs",
      company: "Other Co",
      status: "error",
      hitCount: 0,
      samples: [],
      detail: "The careers page responded with HTTP 403.",
      keywords: "Backend Engineer",
      place: "",
      country: "in",
      method: "browser",
      durationMs: 400,
      openProblem: true,
    });

    expect(await prisma.boardCrawlResult.count()).toBe(2);
    const ok = await listBoardCrawlResults("ok");
    expect(ok).toHaveLength(1);
    expect(ok[0]).toMatchObject({ company: "Example Co", hitCount: 2, status: "ok", resolvedAt: null });
    expect(ok[0].samples).toEqual(["Backend Engineer", "Senior Backend Engineer"]);

    const problems = await listBoardCrawlResults("problems");
    expect(problems.map((row) => row.company)).toEqual(["Other Co"]);

    await markBoardCrawlResolved(problems[0].id);
    expect(await listBoardCrawlResults("problems")).toEqual([]);
    expect(await listBoardCrawlResults("resolved")).toHaveLength(1);
    expect(await clearResolvedBoardCrawls()).toBe(1);
    expect(await prisma.boardCrawlResult.count()).toBe(1);

    const remaining = await listBoardCrawlResults("all");
    await deleteBoardCrawlResult(remaining[0].id);
    expect(await clearAllBoardCrawls()).toBe(0);
  });

  it("auto-resolves soft empties and drops stale catalog URLs", async () => {
    await recordBoardCrawl({
      url: "https://careers.dyson.com/",
      company: "Dyson",
      status: "empty",
      hitCount: 0,
      samples: [],
      detail: "Search ran, but no job links were found on the results page.",
      keywords: "DevOps Engineer",
      place: "",
      country: "in",
      method: "browser",
      durationMs: 8000,
      openProblem: true,
    });
    await recordBoardCrawl({
      url: "https://careers.dyson.com/en-gb/search-results/",
      company: "Dyson",
      status: "empty",
      hitCount: 0,
      samples: ["Associate Principal Hardware Engineer"],
      detail: "Search ran; listings were on the page, but none matched this query.",
      keywords: "DevOps Engineer",
      place: "",
      country: "in",
      method: "browser",
      durationMs: 5000,
      openProblem: false,
    });

    expect(await listBoardCrawlResults("problems")).toHaveLength(1);
    expect(await listBoardCrawlResults("resolved")).toHaveLength(1);
    expect(await syncBoardCrawlWithCatalog(["https://careers.dyson.com/en-gb/search-results/"])).toBe(1);
    expect(await prisma.boardCrawlResult.count()).toBe(1);
    expect((await listBoardCrawlResults("all"))[0].url).toContain("/search-results");
  });
});
