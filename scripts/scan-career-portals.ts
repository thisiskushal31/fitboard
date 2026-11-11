/**
 * Search every non-ATS careers URL in job-boards.json for a query (UI keywords,
 * not a hardcoded role). Reports which sites return listings.
 *
 * Usage:
 *   SCAN_KEYWORDS="Backend Engineer" SCAN_COUNTRY=in \
 *     FITBOARD_DATA_DIR=./tmp/data node --import tsx scripts/scan-career-portals.ts
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

import { careerSitesForSearch } from "../src/lib/job-search/board-crawl";
import { searchCareerPage, resetCareerSearchPoolForTests } from "../src/lib/job-search/career-page-search";

const KEYWORDS = (process.env.SCAN_KEYWORDS || "").trim();
const PLACE = (process.env.SCAN_PLACE || "").trim();
const COUNTRY = (process.env.SCAN_COUNTRY || "in").trim();
const OUT = path.join(process.cwd(), "tmp", "career-portal-scan.json");

if (!KEYWORDS) {
  console.error("Set SCAN_KEYWORDS to the role to search (same as the UI search box).");
  process.exit(1);
}

async function main() {
  process.env.FITBOARD_DATA_DIR ??= "./tmp/data";
  await mkdir(path.dirname(OUT), { recursive: true });
  await rm(path.join(process.env.FITBOARD_DATA_DIR, "career-search-cache"), { recursive: true, force: true }).catch(() => undefined);

  const sites = careerSitesForSearch(KEYWORDS);
  console.log(`Scanning ${sites.length} career portals for "${KEYWORDS}" (${PLACE || COUNTRY})…`);

  const rows: {
    name: string;
    url: string;
    status: "ok" | "empty" | "error";
    hits: number;
    ms: number;
    sample: string | null;
    error: string | null;
  }[] = [];

  let next = 0;
  const concurrency = 6;
  async function worker() {
    while (next < sites.length) {
      const index = next++;
      const site = sites[index];
      const started = Date.now();
      try {
        const jobs = await searchCareerPage(
          { name: site.name, url: site.url },
          { keywords: KEYWORDS, place: PLACE, country: COUNTRY },
        );
        rows[index] = {
          name: site.name,
          url: site.url,
          status: jobs.length > 0 ? "ok" : "empty",
          hits: jobs.length,
          ms: Date.now() - started,
          sample: jobs[0] ? `${jobs[0].title} · ${jobs[0].place}` : null,
          error: null,
        };
      } catch (error) {
        rows[index] = {
          name: site.name,
          url: site.url,
          status: "error",
          hits: 0,
          ms: Date.now() - started,
          sample: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const done = rows.filter(Boolean).length;
      if (done % 10 === 0 || done === sites.length) {
        const ok = rows.filter((row) => row?.status === "ok").length;
        console.log(`  ${done}/${sites.length} (ok=${ok}) last=${site.name} hits=${rows[index].hits}`);
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  resetCareerSearchPoolForTests();

  const ok = rows.filter((row) => row.status === "ok");
  const empty = rows.filter((row) => row.status === "empty");
  const errored = rows.filter((row) => row.status === "error");
  const report = {
    at: new Date().toISOString(),
    query: { keywords: KEYWORDS, place: PLACE, country: COUNTRY },
    summary: {
      scanned: rows.length,
      withHits: ok.length,
      empty: empty.length,
      errors: errored.length,
      hitSum: rows.reduce((sum, row) => sum + row.hits, 0),
    },
    withHits: ok
      .sort((a, b) => b.hits - a.hits)
      .map((row) => ({ name: row.name, hits: row.hits, sample: row.sample, url: row.url })),
    empty: empty.map((row) => ({ name: row.name, url: row.url })),
    errors: errored.map((row) => ({ name: row.name, error: row.error, url: row.url })),
  };
  await writeFile(OUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.summary, null, 2));
  console.log(`Wrote ${OUT}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
