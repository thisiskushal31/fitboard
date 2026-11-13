/**
 * Live "does this board return openings?" scan for DevOps India.
 *
 * - Every ATS company URL (Greenhouse/Lever/Ashby/Workday/…)
 * - Every career site the product would open for "DevOps Engineer"
 *   (priority MNCs + ranked portals, capped at CAREER_SEARCH_SITE_CAP)
 * - Shared jobBoards + RSS feeds
 *
 * Usage:
 *   FITBOARD_DATA_DIR=./tmp/data node --import tsx scripts/scan-live-outputs.ts
 * Optional: SCAN_CAREER_LIMIT=50 (debug), SCAN_ATS_CONCURRENCY=20
 */
import { mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";

import catalog from "../config/job-boards.json";
import { careerSitesForSearch, officialCareers, matchesSearchKeywords } from "../src/lib/job-search/board-crawl";
import { searchCareerPage, resetCareerSearchPoolForTests } from "../src/lib/job-search/career-page-search";

type Row = {
  name: string;
  url: string;
  kind: string;
  status: "ok" | "empty" | "error";
  totalOnBoard: number | null;
  relevantHits: number;
  sampleTitles: string[];
  error: string | null;
};

const KEYWORDS = "DevOps Engineer";
const PLACE = "India";
const COUNTRY = "IN";
const ATS_CONCURRENCY = Number(process.env.SCAN_ATS_CONCURRENCY || 20);
const CAREER_LIMIT = process.env.SCAN_CAREER_LIMIT ? Number(process.env.SCAN_CAREER_LIMIT) : null;
const OUT = path.join(process.cwd(), "tmp", "live-board-scan.json");
const TIMEOUT_MS = 20_000;
const USER_AGENT = "Fitboard/1.0 (live board scan)";

const isRelevantListing = (title: string, description = "") => matchesSearchKeywords(title, description, KEYWORDS);

function readBoard(url: string): { kind: string; slug?: string; host?: string; tenant?: string; site?: string; base?: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const parts = parsed.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const slug = parts[0] ?? "";
  if (
    (host === "job-boards.greenhouse.io" ||
      host === "boards.greenhouse.io" ||
      host === "job-boards.eu.greenhouse.io" ||
      host === "boards.eu.greenhouse.io") &&
    slug
  ) {
    return { kind: "greenhouse", slug };
  }
  if (host === "jobs.lever.co" && slug) return { kind: "lever", slug };
  if (host === "jobs.ashbyhq.com" && slug) return { kind: "ashby", slug };
  if (host.endsWith(".recruitee.com") && host !== "recruitee.com") {
    return { kind: "recruitee", slug: host.slice(0, -".recruitee.com".length) };
  }
  if (host === "jobs.smartrecruiters.com" && slug) return { kind: "smartrecruiters", slug };
  if (host.endsWith(".myworkdayjobs.com")) {
    const tenant = host.split(".")[0];
    const locale = parts[0] && /^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(parts[0]) ? parts[0] : null;
    const site = locale ? parts[1] : parts[0];
    if (!tenant || !site) return null;
    const origin = `${parsed.protocol}//${parsed.hostname}`;
    const base = locale ? `${origin}/${locale}/${site}` : `${origin}/${site}`;
    return { kind: "workday", host: parsed.hostname.toLowerCase(), tenant, site, base };
  }
  return null;
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "user-agent": USER_AGENT, accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function stripHtml(value: string | null | undefined): string {
  if (!value) return "";
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

async function scanAts(name: string, url: string): Promise<Row> {
  const board = readBoard(url);
  if (!board) {
    return { name, url, kind: "unknown", status: "error", totalOnBoard: null, relevantHits: 0, sampleTitles: [], error: "not an ATS URL" };
  }
  try {
    const titles: string[] = [];
    let total = 0;
    let relevant = 0;

    if (board.kind === "greenhouse") {
      const payload = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board.slug!)}/jobs?content=true`)) as {
        jobs?: { title?: string; content?: string }[];
      };
      const jobs = payload.jobs ?? [];
      total = jobs.length;
      for (const job of jobs) {
        const title = job.title ?? "";
        if (isRelevantListing(title, stripHtml(job.content))) {
          relevant += 1;
          if (titles.length < 3) titles.push(title);
        }
      }
    } else if (board.kind === "lever") {
      const payload = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(board.slug!)}?mode=json`);
      const jobs = Array.isArray(payload) ? payload : [];
      total = jobs.length;
      for (const job of jobs as { text?: string; descriptionPlain?: string; description?: string }[]) {
        const title = job.text ?? "";
        if (isRelevantListing(title, stripHtml(job.descriptionPlain || job.description))) {
          relevant += 1;
          if (titles.length < 3) titles.push(title);
        }
      }
    } else if (board.kind === "ashby") {
      const payload = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.slug!)}`)) as {
        jobs?: { title?: string; descriptionHtml?: string; descriptionPlain?: string }[];
      };
      const jobs = payload.jobs ?? [];
      total = jobs.length;
      for (const job of jobs) {
        const title = job.title ?? "";
        if (isRelevantListing(title, stripHtml(job.descriptionHtml || job.descriptionPlain))) {
          relevant += 1;
          if (titles.length < 3) titles.push(title);
        }
      }
    } else if (board.kind === "recruitee") {
      const payload = (await getJson(`https://${encodeURIComponent(board.slug!)}.recruitee.com/api/offers/`)) as {
        offers?: { title?: string; description?: string }[];
      };
      const jobs = payload.offers ?? [];
      total = jobs.length;
      for (const job of jobs) {
        const title = job.title ?? "";
        if (isRelevantListing(title, stripHtml(job.description))) {
          relevant += 1;
          if (titles.length < 3) titles.push(title);
        }
      }
    } else if (board.kind === "smartrecruiters") {
      const payload = (await getJson(
        `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.slug!)}/postings?limit=100&offset=0`,
      )) as { totalFound?: number; content?: { name?: string }[] };
      total = payload.totalFound ?? (payload.content ?? []).length;
      for (const job of payload.content ?? []) {
        const title = job.name ?? "";
        if (isRelevantListing(title)) {
          relevant += 1;
          if (titles.length < 3) titles.push(title);
        }
      }
    } else if (board.kind === "workday") {
      const endpoint = `https://${board.host}/wday/cxs/${encodeURIComponent(board.tenant!)}/${encodeURIComponent(board.site!)}/jobs`;
      const payload = (await postJson(endpoint, { appliedFacets: {}, limit: 20, offset: 0, searchText: KEYWORDS })) as {
        total?: number;
        jobPostings?: { title?: string }[];
      };
      total = payload.total ?? (payload.jobPostings ?? []).length;
      for (const job of payload.jobPostings ?? []) {
        const title = job.title ?? "";
        if (isRelevantListing(title)) {
          relevant += 1;
          if (titles.length < 3) titles.push(title);
        }
      }
    }

    return {
      name,
      url,
      kind: board.kind,
      status: relevant > 0 ? "ok" : total > 0 ? "empty" : "empty",
      totalOnBoard: total,
      relevantHits: relevant,
      sampleTitles: titles,
      error: null,
    };
  } catch (error) {
    return {
      name,
      url,
      kind: board.kind,
      status: "error",
      totalOnBoard: null,
      relevantHits: 0,
      sampleTitles: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function poolMap<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      out[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => worker()));
  return out;
}

async function main() {
  process.env.FITBOARD_DATA_DIR ??= "./tmp/data";
  await mkdir(path.dirname(OUT), { recursive: true });
  await rm(path.join(process.env.FITBOARD_DATA_DIR, "career-search-cache"), { recursive: true, force: true }).catch(() => undefined);

  const companies = catalog.companies.filter((row) => row.name && row.url);
  const atsCompanies = companies.filter((row) => readBoard(row.url));
  const allCareer = officialCareers();
  let careerTargets = careerSitesForSearch(KEYWORDS);
  if (CAREER_LIMIT != null) careerTargets = careerTargets.slice(0, CAREER_LIMIT);

  console.log(
    JSON.stringify(
      {
        keywords: KEYWORDS,
        place: PLACE,
        atsCount: atsCompanies.length,
        careerCatalog: allCareer.length,
        careerScan: careerTargets.length,
        outsideCap: Math.max(0, allCareer.length - careerTargets.length),
      },
      null,
      2,
    ),
  );

  console.log(`\nScanning ${atsCompanies.length} ATS boards…`);
  let atsDone = 0;
  const atsRows = await poolMap(atsCompanies, ATS_CONCURRENCY, async (row) => {
    const result = await scanAts(row.name, row.url);
    atsDone += 1;
    if (atsDone % 50 === 0 || atsDone === atsCompanies.length) {
      console.log(`  ATS ${atsDone}/${atsCompanies.length}`);
    }
    return result;
  });

  console.log(`\nScanning ${careerTargets.length} career portals (product pick for "${KEYWORDS}")…`);
  let careerDone = 0;
  const careerRows = await poolMap(careerTargets, 6, async (company) => {
    const started = Date.now();
    let row: Row;
    try {
      const jobs = await searchCareerPage(
        { name: company.name, url: company.url },
        { keywords: KEYWORDS, place: PLACE, country: COUNTRY },
      );
      row = {
        name: company.name,
        url: company.url,
        kind: "career-browser",
        status: jobs.length > 0 ? "ok" : "empty",
        totalOnBoard: jobs.length,
        relevantHits: jobs.length,
        sampleTitles: jobs.slice(0, 3).map((job) => job.title),
        error: null,
      };
    } catch (error) {
      row = {
        name: company.name,
        url: company.url,
        kind: "career-browser",
        status: "error",
        totalOnBoard: null,
        relevantHits: 0,
        sampleTitles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
    careerDone += 1;
    console.log(
      `  career ${careerDone}/${careerTargets.length} ${company.name}: ${row.status} hits=${row.relevantHits} (${Date.now() - started}ms)`,
    );
    return row;
  });

  resetCareerSearchPoolForTests();

  const summarize = (rows: Row[]) => {
    const ok = rows.filter((row) => row.status === "ok");
    const empty = rows.filter((row) => row.status === "empty");
    const error = rows.filter((row) => row.status === "error");
    const withBoardJobs = rows.filter((row) => (row.totalOnBoard ?? 0) > 0);
    return {
      scanned: rows.length,
      returningRelevantOrSearchHits: ok.length,
      reachableButNoHits: empty.length,
      errors: error.length,
      boardsWithAnyListings: withBoardJobs.length,
      hitSum: rows.reduce((sum, row) => sum + row.relevantHits, 0),
    };
  };

  const priorityNames = new Set(
    [
      "Accenture",
      "Amazon",
      "Capgemini",
      "Cognizant",
      "Deloitte",
      "Ericsson",
      "Genpact",
      "Goldman Sachs",
      "Google",
      "HCLTech",
      "HDFC Bank",
      "HSBC",
      "IBM",
      "Infosys",
      "JPMorgan",
      "JPMorgan Chase",
      "Microsoft",
      "Morgan Stanley",
      "Oracle",
      "TCS",
      "Tech Mahindra",
      "Wipro",
    ].map((name) => name.toLowerCase()),
  );
  const priority = careerRows.filter((row) => priorityNames.has(row.name.toLowerCase()));

  const report = {
    at: new Date().toISOString(),
    query: { keywords: KEYWORDS, place: PLACE, country: COUNTRY },
    scope: {
      atsCompanies: atsCompanies.length,
      careerCatalog: allCareer.length,
      careerScanned: careerTargets.length,
      careerOutsideProductCap: Math.max(0, allCareer.length - careerTargets.length),
      note: "Career scan covers the exact set crawlPublicBoards opens for this query (priority MNCs + ranked portals, capped at 200). Remaining catalog career URLs are not opened in a normal search.",
    },
    summary: {
      ats: summarize(atsRows),
      career: summarize(careerRows),
      priorityMncs: summarize(priority),
    },
    priorityMncs: priority.map((row) => ({
      name: row.name,
      status: row.status,
      hits: row.relevantHits,
      samples: row.sampleTitles,
      error: row.error,
    })),
    atsWithHits: atsRows
      .filter((row) => row.status === "ok")
      .sort((a, b) => b.relevantHits - a.relevantHits)
      .slice(0, 40)
      .map((row) => ({ name: row.name, kind: row.kind, hits: row.relevantHits, boardTotal: row.totalOnBoard, samples: row.sampleTitles })),
    atsEmptyButHasJobs: atsRows
      .filter((row) => row.status === "empty" && (row.totalOnBoard ?? 0) > 0)
      .length,
    atsErrors: atsRows.filter((row) => row.status === "error").slice(0, 30).map((row) => ({ name: row.name, kind: row.kind, error: row.error })),
    careerWithHits: careerRows
      .filter((row) => row.status === "ok")
      .sort((a, b) => b.relevantHits - a.relevantHits)
      .map((row) => ({ name: row.name, hits: row.relevantHits, samples: row.sampleTitles })),
    careerEmpty: careerRows.filter((row) => row.status === "empty").map((row) => ({ name: row.name, url: row.url })),
    careerErrors: careerRows.filter((row) => row.status === "error").map((row) => ({ name: row.name, error: row.error, url: row.url })),
    rows: { ats: atsRows, career: careerRows },
  };

  await writeFile(OUT, JSON.stringify(report, null, 2));
  console.log(`\nWrote ${OUT}`);
  console.log(JSON.stringify(report.summary, null, 2));
  console.log("\nPriority MNCs:");
  console.log(JSON.stringify(report.priorityMncs, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
