import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, type Browser, type Frame, type Locator, type Page } from "playwright-core";

import { env } from "@/lib/core/env";

import { countryName } from "./countries";
import { recordBoardCrawl, type BoardCrawlStatus } from "./crawl-results";
import {
  expandRelatedRoleTerms,
  queryTokens,
  roleMatchesQuery,
  specialtyTokens,
  specialtyTokensRelated,
} from "./related-roles";

// Re-export match helpers for tests / callers that import from this module.
export { queryTokens, roleMatchesQuery, specialtyTokens, specialtyTokensRelated };

// Opens the exact careers URL from job-boards.json, types the search, and
// reads the job links that appear. The JSON must already be the real search
// portal, not a marketing page. Used for catalog rows that are not
// Greenhouse, Lever, Ashby, Recruitee, SmartRecruiters, or Workday.

export type CareerPageCompany = { name: string; url: string };
export type CareerPagePosting = {
  externalId: string;
  title: string;
  company: string;
  place: string;
  remote: boolean | null;
  salary: string;
  postedAt: string | null;
  url: string;
  via: string;
  description: string;
};

const PAGE_TIMEOUT_MS = 20_000;
/** Full navigation budget (commit + settle) for heavy WordPress/marketing careers pages. */
const GOTO_TIMEOUT_MS = process.env.VITEST ? 5_000 : 45_000;
/** Fail over from a stuck domcontentloaded quickly — many careers hosts never fire it. */
const GOTO_DCL_ATTEMPT_MS = process.env.VITEST ? 2_000 : 12_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CONCURRENT_PAGES = 6;
const IDLE_MS = 5 * 60_000;
/** Cap listings per company; also the preferred page-size when a portal exposes one. */
const MAX_JOBS_PER_SITE = 50;
const MAX_LISTING_PAGES = 20;
const SETTLE_MS = process.env.VITEST ? 0 : 800;
const AFTER_SEARCH_MS = process.env.VITEST ? 0 : 2_500;

const USER_AGENT = "Fitboard/1.0 (career page search)";

export type CareerSearchQuery = { keywords: string; place: string; country: string };

type CacheEntry = { at: number; jobs: CareerPagePosting[] };

type Pool = {
  browser: Promise<Browser> | null;
  active: number;
  queue: (() => void)[];
  idleTimer: ReturnType<typeof setTimeout> | null;
};

const globalForCareers = globalThis as unknown as { careerSearchPool?: Pool };
const pool: Pool = (globalForCareers.careerSearchPool ??= {
  browser: null,
  active: 0,
  queue: [],
  idleTimer: null,
});

function browser(): Promise<Browser> {
  if (!pool.browser) {
    const launching = chromium
      .launch({ args: ["--disable-dev-shm-usage"] })
      .then((launched) => {
        launched.on("disconnected", () => {
          if (pool.browser === launching) pool.browser = null;
        });
        return launched;
      });
    launching.catch(() => {
      if (pool.browser === launching) pool.browser = null;
    });
    pool.browser = launching;
  }
  return pool.browser;
}

async function acquire(): Promise<void> {
  if (pool.idleTimer) clearTimeout(pool.idleTimer);
  pool.idleTimer = null;
  if (pool.active < MAX_CONCURRENT_PAGES) {
    pool.active += 1;
    return;
  }
  await new Promise<void>((resolve) => pool.queue.push(resolve));
  pool.active += 1;
}

function release(): void {
  pool.active = Math.max(0, pool.active - 1);
  const next = pool.queue.shift();
  if (next) return next();
  if (pool.active === 0 && pool.browser) {
    pool.idleTimer = setTimeout(() => {
      void pool.browser?.then((launched) => launched.close()).catch(() => undefined);
      pool.browser = null;
      pool.idleTimer = null;
    }, IDLE_MS);
  }
}

function cacheDir(): string {
  return path.join(env.FITBOARD_DATA_DIR, "career-search-cache");
}

function cacheKey(url: string, query: CareerSearchQuery): string {
  return createHash("sha256").update(JSON.stringify({ url, ...query })).digest("hex");
}

async function readCache(key: string): Promise<CareerPagePosting[] | null> {
  try {
    const raw = await readFile(path.join(cacheDir(), `${key}.json`), "utf8");
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || typeof entry.at !== "number" || !Array.isArray(entry.jobs)) return null;
    if (Date.now() - entry.at > CACHE_TTL_MS) return null;
    return entry.jobs;
  } catch {
    return null;
  }
}

async function writeCache(key: string, jobs: CareerPagePosting[]): Promise<void> {
  try {
    const dir = cacheDir();
    await mkdir(dir, { recursive: true });
    const entry: CacheEntry = { at: Date.now(), jobs };
    await writeFile(path.join(dir, `${key}.json`), JSON.stringify(entry));
  } catch {
    // Cache is best-effort; a full disk must not stop the crawl.
  }
}

/** Query params that mark a single posting (id=, Greenhouse gh_jid, etc.). */
const JOB_QUERY = /[?&](?:jobId|job_id|gh_jid|requisition|pid|id)=/i;

/** Path shapes for one posting on a careers search-results page. */
const JOB_PATH =
  /\/(?:careers?\/)?(?:job-?descriptions?|jobdetails?|job-detail|jobs?|job|position|opening|vacanc(?:y|ies)|requisition)(?:\/|$|\.)|\/career\/[a-z0-9][a-z0-9-]{2,}(?:\/|$)/i;

/** Whether a link looks like a single job posting, not the careers home. */
export function isJobHref(href: string, pageUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(href, pageUrl);
  } catch {
    return false;
  }
  if (!/^https?:$/i.test(parsed.protocol)) return false;
  const pathName = parsed.pathname.toLowerCase();
  if (!pathName || pathName === "/") return JOB_QUERY.test(parsed.search);
  if (/\/(login|signin|signup|register|cookie|privacy|terms|about|blog|news|press)\b/i.test(pathName)) return false;
  return JOB_PATH.test(pathName) || JOB_QUERY.test(parsed.search);
}

type RawJob = { title: string; url: string; place: string; description: string };

async function filterJobsByQuery(jobs: RawJob[], keywords: string, signal?: AbortSignal): Promise<RawJob[]> {
  const trimmed = keywords.trim();
  if (!trimmed) return jobs;
  // AI (when configured) + compound heuristics expand "DevOps" → DevSecOps/SRE/…
  // for any discipline — not a hardcoded map.
  const related = await expandRelatedRoleTerms(trimmed, signal);
  return jobs.filter((job) => roleMatchesQuery(job.title, trimmed, job.place, related));
}

/** Phenom/Eightfold-style domain from a careers URL, when the public jobs API may answer. */
export function phenomDomainFromUrl(pageUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }
  const fromQuery = parsed.searchParams.get("domain")?.trim();
  if (fromQuery) return fromQuery;
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const match =
    host.match(/^portal\.careers\.(.+)$/i) ||
    host.match(/^careers\.(.+)$/i) ||
    host.match(/^jobs\.(.+)$/i);
  return match?.[1] ?? null;
}

/** accenture.com elastic job search when the catalog URL is on that host. */
export async function searchAccentureJobs(
  pageUrl: string,
  keywords: string,
  location: string,
  signal?: AbortSignal,
): Promise<RawJob[] | null> {
  let parsed: URL;
  try {
    parsed = new URL(pageUrl);
  } catch {
    return null;
  }
  if (!/(^|\.)accenture\.com$/i.test(parsed.hostname)) return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const countrySite = parts[0] && /^[a-z]{2}-[a-z]{2}$/i.test(parts[0]) ? parts[0] : "in-en";
  const jobCountry =
    location.trim() ||
    ({
      in: "India",
      us: "United States of America",
      gb: "United Kingdom",
      ie: "Ireland",
      au: "Australia",
      sg: "Singapore",
      de: "Germany",
      ca: "Canada",
    }[countrySite.slice(0, 2).toLowerCase()] ?? "India");
  const body = new URLSearchParams({
    startIndex: "0",
    maxResultSize: String(MAX_JOBS_PER_SITE),
    jobKeyword: keywords,
    jobCountry,
    jobLanguage: countrySite.split("-")[1] || "en",
    countrySite,
    sortBy: "0",
    searchType: "vectorSearch",
    jobFilters: "[]",
  });
  try {
    const response = await fetch("https://www.accenture.com/api/accenture/elastic/findjobs", {
      method: "POST",
      signal,
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
        "user-agent": USER_AGENT,
        referer: pageUrl,
      },
      body,
      redirect: "follow",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      data?: { title?: string; jobDetailUrl?: string; country?: string; state?: string; city?: string; description?: string }[];
      error?: string;
    };
    if (payload.error || !Array.isArray(payload.data)) return null;
    const jobs: RawJob[] = [];
    for (const item of payload.data.slice(0, MAX_JOBS_PER_SITE)) {
      const title = (item.title || "").trim();
      let url = (item.jobDetailUrl || "").trim();
      if (!title || !url) continue;
      url = url.replace("{0}", countrySite);
      const place = [item.city, item.state, item.country].filter(Boolean).join(", ");
      jobs.push({
        title: title.slice(0, 500),
        url: url.slice(0, 2000),
        place: place.slice(0, 300),
        description: String(item.description || "").slice(0, 100_000),
      });
    }
    return jobs;
  } catch {
    return null;
  }
}

/**
 * Fast path for Phenom-hosted portals: JSON search without Chromium.
 * Returns null when the host is not Phenom or the API refuses, so the browser path can run.
 */
export async function searchPhenomJobs(
  pageUrl: string,
  keywords: string,
  location: string,
  signal?: AbortSignal,
): Promise<RawJob[] | null> {
  const domain = phenomDomainFromUrl(pageUrl);
  if (!domain) return null;
  let origin: string;
  try {
    origin = new URL(pageUrl).origin;
  } catch {
    return null;
  }
  const api = new URL("/api/apply/v2/jobs", origin);
  api.searchParams.set("domain", domain);
  api.searchParams.set("query", keywords);
  if (location.trim()) api.searchParams.set("location", location.trim());
  api.searchParams.set("start", "0");
  api.searchParams.set("sort_by", "relevance");
  api.searchParams.set("hl", "en");
  try {
    const response = await fetch(api, {
      signal,
      headers: {
        accept: "application/json",
        "user-agent": USER_AGENT,
        "accept-language": "en-US,en;q=0.9",
        referer: pageUrl,
      },
      redirect: "follow",
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      positions?: {
        id?: string | number;
        name?: string;
        posting_name?: string;
        location?: string;
        locations?: string[];
        canonicalPositionUrl?: string;
        job_description?: string;
      }[];
    };
    if (!Array.isArray(payload.positions)) return null;
    const jobs: RawJob[] = [];
    for (const item of payload.positions.slice(0, MAX_JOBS_PER_SITE)) {
      const id = item.id;
      const title = (item.posting_name || item.name || "").trim();
      if (!title || id == null) continue;
      const url =
        item.canonicalPositionUrl?.trim() ||
        `${origin}/careers/job/${encodeURIComponent(String(id))}`;
      const place = String(item.location || item.locations?.[0] || "").trim();
      jobs.push({
        title: title.slice(0, 500),
        url: url.slice(0, 2000),
        place: place.slice(0, 300),
        description: String(item.job_description || "").slice(0, 100_000),
      });
    }
    return jobs;
  } catch {
    return null;
  }
}

/**
 * Early-careers programme carousels (e.g. JLR): tabbed slick sliders with
 * `.programme-card` slides. Cards for inactive tabs usually stay in the DOM;
 * we still click tabs + Next so lazy-mounted slides are revealed too.
 */
async function revealProgrammeCarousels(page: Page): Promise<void> {
  const section = page.locator(".programme_slider_tabbed, section:has(.programme-card)").first();
  if ((await section.count()) === 0) return;

  const tabs = page.locator(
    ".programme-tabs a, .programme_slider_tabbed [class*='programme-tab'] a, .programme_slider_tabbed [role='tab']",
  );
  const tabCount = Math.min(await tabs.count(), 8);
  for (let i = 0; i < Math.max(tabCount, 1); i++) {
    if (tabCount > 0) {
      try {
        await tabs.nth(i).click({ timeout: 1_500, force: true });
      } catch {
        // Tab may already be active or detached.
      }
    }
    const next = page.locator(".tab-pane.active .slick-next, .programme_slider_tabbed .slick-next").first();
    for (let step = 0; step < 10; step++) {
      if ((await next.count()) === 0) break;
      try {
        await next.click({ timeout: 800, force: true });
      } catch {
        break;
      }
    }
  }
}

/** Collect apprenticeship / undergraduate / graduate programme cards. */
async function collectProgrammeListings(page: Page, pageUrl: string): Promise<RawJob[]> {
  // Keep this callback free of nested named functions: tsx/esbuild's __name
  // helper is not available inside Playwright's browser realm.
  return page.evaluate((base) => {
    const out: { title: string; url: string; place: string; description: string }[] = [];
    const seen = new Set<string>();
    const cards = Array.from(
      document.querySelectorAll(
        ".programme-card:not(.slick-cloned), [class*='programme-card']:not(.slick-cloned)",
      ),
    );
    for (const card of cards) {
      const nameNode = card.querySelector(".programme-name, h2, h3, h4");
      const title = (nameNode?.textContent || "").replace(/\s+/g, " ").trim();
      if (title.length < 3) continue;
      const anchor = card.querySelector("a[href]") as HTMLAnchorElement | null;
      const href = anchor?.href || "";
      if (!href || /#$/.test(href)) continue;
      let absolute = href;
      try {
        const parsed = new URL(href, base);
        if (!/^https?:$/i.test(parsed.protocol)) continue;
        absolute = parsed.toString();
      } catch {
        continue;
      }
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      const info = (card.querySelector(".programme-info, .programme-details")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      const track = (card.closest(".tab-pane")?.id || "").replace(/-/g, " ").trim();
      const place = [track, info.replace(/\s*Find out more\s*$/i, "").trim()].filter(Boolean).join(" · ").slice(0, 300);
      out.push({
        title: title.slice(0, 500),
        url: absolute.slice(0, 2000),
        place,
        description: info.slice(0, 100_000),
      });
      if (out.length >= 40) break;
    }
    return out;
  }, pageUrl);
}

function mergeRawJobs(...groups: RawJob[][]): RawJob[] {
  const out: RawJob[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const job of group) {
      if (!job.url || seen.has(job.url)) continue;
      seen.add(job.url);
      out.push(job);
      if (out.length >= MAX_JOBS_PER_SITE) return out;
    }
  }
  return out;
}

const LOCATION_FILTER_SELECT =
  "#job-locations, #jobs select, #all-jobs select, .job-filter select, select[id*='location' i], select[name*='location' i]";

/** Brand / business-line selectors (e.g. InCred Finance / Capital / Wealth scroll). */
const BRAND_FILTER_SELECT =
  "select.mob-select, #apply-now select, .apply-job select, select:has(option[value*='InCred' i]), select:has(option[value*='Finance' i]):has(option[value*='Capital' i])";

/**
 * Open a careers URL. Hosts like i-exceed / HummingBrains often hang on
 * domcontentloaded (analytics, chat widgets). Try a short DCL wait, then
 * accept commit + body so the crawl can continue.
 */
async function openCareersUrl(
  page: Page,
  url: string,
): Promise<{ ok: boolean; status: number; detail?: string }> {
  page.setDefaultNavigationTimeout(GOTO_TIMEOUT_MS);

  let response: Awaited<ReturnType<Page["goto"]>> | null = null;
  try {
    response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: GOTO_DCL_ATTEMPT_MS });
  } catch {
    try {
      response = await page.goto(url, { waitUntil: "commit", timeout: GOTO_TIMEOUT_MS });
      await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => undefined);
      if (SETTLE_MS) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    } catch (error) {
      const message = error instanceof Error ? error.message.slice(0, 300) : "Navigation timed out.";
      return { ok: false, status: 0, detail: message };
    }
  }

  const status = response?.status() ?? 0;
  if (response && status >= 400) {
    return { ok: false, status, detail: `The careers page responded with HTTP ${status}.` };
  }

  const hasBody = await page
    .evaluate(() => Boolean(document.body && (document.body.innerHTML || "").length > 80))
    .catch(() => false);
  if (hasBody) return { ok: true, status: status || 200 };
  if (response) return { ok: true, status: status || 200 };
  return { ok: false, status: 0, detail: "The careers page did not respond." };
}

/** True when the page filters openings by location instead of a keyword search (e.g. JioSaavn). */
async function hasLocationJobFilter(page: Page): Promise<boolean> {
  const select = page.locator(LOCATION_FILTER_SELECT).first();
  if ((await select.count()) === 0) return false;
  const listings = page.locator(
    "#jobs .job-list li, #all-jobs .job-list li, .nav-list.job-group li, .nav-list li[data-locale], #jobs li[data-locale]",
  );
  const filterUi = page.locator("#jobs, #all-jobs, .job-filter, text=Find Your Gig").first();
  return (await listings.count()) > 0 || (await filterUi.count()) > 0;
}

/**
 * Location-only career pages: pick the matching office from the dropdown
 * (or "all"), then collect department job lists that use data-locale.
 */
async function applyLocationFilter(page: Page, location: string): Promise<boolean> {
  const select = page.locator(LOCATION_FILTER_SELECT).first();
  if ((await select.count()) === 0) return false;

  const wanted = location.trim().toLowerCase();
  try {
    if (!wanted) {
      await select.selectOption({ value: "all" }).catch(async () => {
        await select.selectOption({ label: "All Locations" });
      });
    } else {
      const matched = await select.evaluate(
        (el, needle) => {
          const options = Array.from((el as HTMLSelectElement).options);
          const hit =
            options.find((opt) => !opt.disabled && opt.value && opt.value.toLowerCase() === needle) ||
            options.find(
              (opt) =>
                !opt.disabled &&
                opt.value &&
                (opt.text.toLowerCase().includes(needle) || opt.value.toLowerCase().includes(needle)),
            ) ||
            options.find(
              (opt) =>
                !opt.disabled &&
                opt.value &&
                needle.split(/[\s,]+/).some((part) => part.length > 2 && (opt.text.toLowerCase().includes(part) || opt.value.toLowerCase().includes(part))),
            );
          return hit ? { value: hit.value } : { value: "all" };
        },
        wanted,
      );
      await select.selectOption(matched);
    }
    await select.dispatchEvent("change");
  } catch {
    // Still try to read whatever listings are visible.
  }
  if (SETTLE_MS) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  return true;
}

/** Collect openings shown for the active brand/business line (InCred-style). */
async function collectBrandOpenings(page: Page, pageUrl: string, brand: string): Promise<RawJob[]> {
  // Keep this callback free of nested named functions: tsx/esbuild's __name
  // helper is not available inside Playwright's browser realm.
  return page.evaluate(
    ({ base, brandLabel }) => {
      const out: { title: string; url: string; place: string; description: string }[] = [];
      const seen = new Set<string>();
      const root =
        document.querySelector(".apply-job .dropdown, .dropdown-box .dropdown, #apply-now .dropdown, .apply-job") ||
        document.body;
      const emptyOnly = Array.from(root.querySelectorAll("p, span, div")).some(
        (node) => /^no current opening\.?$/i.test((node.textContent || "").replace(/\s+/g, " ").trim()),
      );
      const hasApplyLink = Boolean(root.querySelector("a[href]"));
      if (emptyOnly && !hasApplyLink) return out;
      const nodes = Array.from(
        root.querySelectorAll(
          "a[href], li, .dropdown-item, [class*='job'], [class*='opening'], [class*='position'], h3, h4",
        ),
      );
      for (const node of nodes) {
        const style = window.getComputedStyle(node);
        if (style.display === "none" || style.visibility === "hidden") continue;
        const text = (node.textContent || "").replace(/\s+/g, " ").trim();
        if (text.length < 3 || text.length > 180) continue;
        if (/no current opening|check out the open|join us|incred finance is|drop us an email/i.test(text)) continue;
        if (/^(apply now|apply|view)$/i.test(text)) continue;
        let href = "";
        const anchor =
          node.tagName === "A"
            ? (node as HTMLAnchorElement)
            : (node.querySelector("a[href]") as HTMLAnchorElement | null);
        if (anchor?.href && !/#$/.test(anchor.href)) href = anchor.href;
        let absolute = href;
        if (href) {
          try {
            const parsed = new URL(href, base);
            if (!/^https?:$/i.test(parsed.protocol)) continue;
            absolute = parsed.toString();
          } catch {
            continue;
          }
        } else {
          // Title-only rows still count — synthesize a stable in-page URL.
          absolute = `${base}#${encodeURIComponent(`${brandLabel}:${text}`.toLowerCase())}`;
        }
        if (seen.has(absolute) || seen.has(text.toLowerCase())) continue;
        seen.add(absolute);
        seen.add(text.toLowerCase());
        const title =
          node.tagName === "A"
            ? text.replace(/^(apply(?:\s+now)?)\s*/i, "").trim() || text
            : (node.querySelector("h3, h4, .title, strong")?.textContent || text).replace(/\s+/g, " ").trim();
        if (title.length < 3) continue;
        if (/no current opening/i.test(title)) continue;
        out.push({
          title: title.slice(0, 500),
          url: absolute.slice(0, 2000),
          place: brandLabel.slice(0, 300),
          description: brandLabel.slice(0, 100_000),
        });
        if (out.length >= 50) break;
      }
      return out;
    },
    { base: pageUrl, brandLabel: brand },
  );
}

/**
 * Sweep brand / business-line filters (InCred Finance → Capital → Wealth…).
 * Each option can reveal a different openings list.
 */
async function sweepBrandCategoryFilters(
  page: Page,
  pageUrl: string,
): Promise<{ jobs: RawJob[]; used: boolean }> {
  const select = page.locator(BRAND_FILTER_SELECT).first();
  if ((await select.count()) === 0) return { jobs: [], used: false };

  const values = await select.evaluate((el) =>
    Array.from((el as HTMLSelectElement).options)
      .filter((opt) => !opt.disabled && opt.value.trim())
      .map((opt) => opt.value.trim()),
  );
  if (values.length === 0) return { jobs: [], used: false };

  let jobs: RawJob[] = [];
  for (const value of values.slice(0, 12)) {
    try {
      await select.selectOption(value);
      await select.dispatchEvent("change");
    } catch {
      continue;
    }
    if (SETTLE_MS) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    jobs = mergeRawJobs(jobs, await collectBrandOpenings(page, pageUrl, value));
    if (jobs.length >= MAX_JOBS_PER_SITE) break;
  }
  return { jobs, used: true };
}

/**
 * Marketing-style career cards (e.g. Intellious): title in an h4, Apply Now
 * link to /career/..., no keyword search box.
 */
async function collectCareerCards(page: Page, pageUrl: string): Promise<RawJob[]> {
  // Keep this callback free of nested named functions: tsx/esbuild's __name
  // helper is not available inside Playwright's browser realm.
  return page.evaluate((base) => {
    const out: { title: string; url: string; place: string; description: string }[] = [];
    const seen = new Set<string>();
    const cards = Array.from(
      document.querySelectorAll(".career-card, [class*='career-card'], [class*='job-card'], [class*='opening-card']"),
    );
    for (const card of cards) {
      const style = window.getComputedStyle(card);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const title = (card.querySelector("h4, h3, .sub-title, [class*='title']")?.textContent || "")
        .replace(/\s+/g, " ")
        .trim();
      if (title.length < 3) continue;
      if (/^(apply now|no open positions|roles open|job openings)$/i.test(title)) continue;
      const anchor =
        (card.querySelector("a[href*='/career']") as HTMLAnchorElement | null) ||
        (card.querySelector("a[href]") as HTMLAnchorElement | null);
      const href = anchor?.href || "";
      if (!href || /#$/.test(href)) continue;
      let absolute = href;
      try {
        const parsed = new URL(href, base);
        if (!/^https?:$/i.test(parsed.protocol)) continue;
        absolute = parsed.toString();
      } catch {
        continue;
      }
      if (seen.has(absolute)) continue;
      seen.add(absolute);
      const placeBits = Array.from(
        card.querySelectorAll("[fs-list-field='location'], .country-name, [class*='location']"),
      )
        .map((node) => (node.textContent || "").replace(/\s+/g, " ").trim())
        .filter(
          (text) =>
            Boolean(text) &&
            text.length < 80 &&
            !/^(apply now|work from office|on-?site|hybrid|5 days onsite)$/i.test(text),
        );
      const place = Array.from(new Set(placeBits)).join(", ").slice(0, 300);
      const department =
        card.closest(".career-item, [class*='department']")?.querySelector("h3.sub-title, [fs-list-field='department']")?.textContent?.replace(/\s+/g, " ").trim() ||
        "";
      out.push({
        title: title.slice(0, 500),
        url: absolute.slice(0, 2000),
        place,
        description: department.slice(0, 100_000),
      });
      if (out.length >= 50) break;
    }
    return out;
  }, pageUrl);
}

/** Prefer showing up to 50 results when a page-size control exists. */
async function bumpPageSize(page: Page): Promise<void> {
  const select = page
    .locator(
      'select:has(option[value="50"]), select:has(option:text-is("50")), select[name*="pageSize" i], select[id*="pageSize" i], select[name*="page-size" i], select[aria-label*="page size" i], select[aria-label*="results" i]',
    )
    .first();
  if ((await select.count()) > 0) {
    try {
      await select.selectOption("50");
      if (SETTLE_MS) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      return;
    } catch {
      try {
        await select.selectOption({ label: "50" });
        if (SETTLE_MS) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        return;
      } catch {
        // Fall through to button/option clicks.
      }
    }
  }
  const fifty = page
    .locator(
      'button:has-text("50"), a:has-text("50"), [role="option"]:has-text("50"), [data-value="50"]',
    )
    .first();
  if ((await fifty.count()) === 0) return;
  try {
    await fifty.click({ timeout: 1_500, force: true });
    if (SETTLE_MS) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  } catch {
    // Page size control was not usable.
  }
}

/** Click the next page of listings when pagination is present. */
async function clickNextListingPage(page: Page): Promise<boolean> {
  const next = page
    .locator(
      'a[aria-label*="Next" i]:not([aria-disabled="true"]), button[aria-label*="Next" i]:not([aria-disabled="true"]), a.pagination-next:not(.disabled), button.pagination-next:not(.disabled), .pagination a:has-text("Next"):not(.disabled), .pagination button:has-text("Next"):not([disabled]), nav[aria-label*="pagination" i] a:has-text("Next"), nav[aria-label*="pagination" i] button:has-text("›")',
    )
    .first();
  if ((await next.count()) === 0) return false;
  const disabled = await next.getAttribute("disabled");
  if (disabled != null) return false;
  const classes = (await next.getAttribute("class")) || "";
  if (/\bdisabled\b/i.test(classes)) return false;
  try {
    await next.click({ timeout: 2_000, force: true });
    if (SETTLE_MS) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    return true;
  } catch {
    return false;
  }
}

/** Collect every listing collector across paginated results (up to the site cap). */
async function collectAllListings(page: Page, pageUrl: string): Promise<RawJob[]> {
  await bumpPageSize(page);
  let all: RawJob[] = [];
  for (let pageIndex = 0; pageIndex < MAX_LISTING_PAGES; pageIndex++) {
    all = mergeRawJobs(
      all,
      // Career cards first so "Apply Now" anchors do not claim the posting URL.
      await collectCareerCards(page, pageUrl),
      await collectProgrammeListings(page, pageUrl),
      await collectLocationFilteredListings(page, pageUrl),
      await collectJobs(page, pageUrl),
    );
    if (all.length >= MAX_JOBS_PER_SITE) return all.slice(0, MAX_JOBS_PER_SITE);
    if (!(await clickNextListingPage(page))) break;
  }
  return all;
}

/** Collect jobs from location-filtered department lists (JioSaavn-style). */
async function collectLocationFilteredListings(page: Page, pageUrl: string): Promise<RawJob[]> {
  // Keep this callback free of nested named functions: tsx/esbuild's __name
  // helper is not available inside Playwright's browser realm.
  return page.evaluate((base) => {
    const out: { title: string; url: string; place: string; description: string }[] = [];
    const seen = new Set<string>();
    const items = Array.from(
      document.querySelectorAll(
        "#jobs .job-list li, #all-jobs .job-list li, .nav-list.job-group li, .nav-list li[data-locale], #jobs li[data-locale], #all-jobs li[data-locale]",
      ),
    );
    for (const item of items) {
      const style = window.getComputedStyle(item);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const anchor = item.querySelector("a[href]") as HTMLAnchorElement | null;
      if (!anchor) continue;
      const href = anchor.href || "";
      if (!href || /#$/.test(href)) continue;
      let absolute = href;
      try {
        const parsed = new URL(href, base);
        if (!/^https?:$/i.test(parsed.protocol)) continue;
        absolute = parsed.toString();
      } catch {
        continue;
      }
      if (seen.has(absolute)) continue;
      const title = (
        item.querySelector(".title, p.title, h3, h4")?.textContent ||
        anchor.getAttribute("aria-label") ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      if (title.length < 3) continue;
      if (/^(apply|view|find your|0 openings)$/i.test(title)) continue;
      const place = (
        item.querySelector(".locale, .location, p.locale")?.textContent ||
        (item as HTMLElement).dataset.locale ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim();
      const department =
        item.closest(".nav-list, .job-group")?.querySelector(".department")?.textContent?.replace(/\s+/g, " ").trim() ||
        "";
      seen.add(absolute);
      out.push({
        title: title.slice(0, 500),
        url: absolute.slice(0, 2000),
        place: place.slice(0, 300),
        description: [department, item.querySelector(".type")?.textContent?.trim() || ""].filter(Boolean).join(" · ").slice(0, 100_000),
      });
      if (out.length >= 40) break;
    }
    return out;
  }, pageUrl);
}

/** Collect job-like anchors from the live page DOM after a search submit. */
async function collectJobs(page: Page, pageUrl: string): Promise<RawJob[]> {
  // Keep this callback free of nested named functions: tsx/esbuild's __name
  // helper is not available inside Playwright's browser realm.
  return page.evaluate((base) => {
    const jobPath =
      /\/(?:careers?\/)?(?:job-?descriptions?|jobdetails?|job-detail|jobs?|job|position|opening|vacanc(?:y|ies)|requisition)(?:\/|$|\.)|\/career\/[a-z0-9][a-z0-9-]{2,}(?:\/|$)/i;
    const jobQuery = /[?&](?:jobId|job_id|gh_jid|requisition|pid|id)=/i;
    const skipPath = /\/(login|signin|signup|register|cookie|privacy|terms|about|blog|news|press)\b/i;
    const out: { title: string; url: string; place: string; description: string }[] = [];
    const seen = new Set<string>();

    for (const anchor of Array.from(document.querySelectorAll("a[href]"))) {
      const href = (anchor as HTMLAnchorElement).href;
      if (!href || seen.has(href)) continue;
      let pathName = "";
      let search = "";
      let absolute = href;
      try {
        const parsed = new URL(href, base);
        if (!/^https?:$/i.test(parsed.protocol)) continue;
        pathName = parsed.pathname;
        search = parsed.search;
        absolute = parsed.toString();
      } catch {
        continue;
      }
      if ((!pathName || pathName === "/") && !jobQuery.test(search)) continue;
      if (pathName && pathName !== "/" && skipPath.test(pathName)) continue;
      if (!jobPath.test(pathName) && !jobQuery.test(search)) continue;
      let title = (anchor.textContent || "")
        .replace(/\s+/g, " ")
        .replace(/^more details(?:\s+about)?\s+/i, "")
        .replace(/\s*Posted\s+\d+.*$/i, "")
        .replace(/\s*(Hybrid|Remote|On-?site)\s*$/i, "")
        .trim();
      // "Apply Now" links: pull the role title from the surrounding card.
      if (/^(apply(?:\s+now)?|view(?:\s+job|\s+role)?|see\s+role)$/i.test(title)) {
        const card = anchor.closest(
          ".career-card, [class*='career-card'], [class*='job-card'], li, article, [class*='job'], [class*='card'], [class*='result']",
        );
        title = (card?.querySelector("h4, h3, h2, .title, .programme-name, [class*='title']")?.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
      }
      if (title.length < 3) continue;
      if (title.length > 200) title = title.slice(0, 200);
      if (
        /accept|cookie|consent|necessary only|agree|allow all|skip to main|view all jobs|learn more|read more|click here|^(apply(?:\s+now)?|view|menu|close|more details)$/i.test(
          title,
        )
      ) {
        continue;
      }
      // Search-result deep links (?pid= on /careers) are often chrome; keep /job/ paths.
      const pathLower = pathName.toLowerCase();
      const onListingPath =
        /\/(?:job-?descriptions?|jobdetails?|job-detail|jobs?\/|job\/|position\/|opening\/|vacanc|requisition)/i.test(pathLower);
      if (!onListingPath && jobQuery.test(search)) continue;
      let place = "";
      const card = anchor.closest("li, article, tr, [class*='job'], [class*='card'], [class*='result']");
      if (card) {
        const placeNode = card.querySelector(
          "[class*='location'], [class*='place'], [data-location], [itemprop='jobLocation'], .field-label, .position-location",
        );
        place = (placeNode?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 300);
      }
      // Eightfold often mashes "TitleCity,Region,Country…" into the anchor text.
      if (!place) {
        const mashed = title.match(/^(.{3,80}?)([A-Z][a-z]+(?:,[A-Za-z .]+)+)/);
        if (mashed) {
          title = mashed[1].trim();
          place = mashed[2]
            .replace(/(Service Delivery|Product Development|Business Services|Company Priority|Hybrid|Flexible Location).*$/i, "")
            .trim()
            .slice(0, 300);
        }
      } else {
        place = place
          .replace(/(Service Delivery|Product Development|Business Services|Company Priority).*$/i, "")
          .trim()
          .slice(0, 300);
      }
      seen.add(absolute);
      out.push({ title, url: absolute, place, description: "" });
      if (out.length >= 40) break;
    }
    return out;
  }, pageUrl);
}

// Prefer job-title boxes over generic "search skills" fields (Eightfold).
// Include combobox/searchbox roles — Eightfold/ADP often expose those instead of plain inputs.
const SEARCH_INPUT = [
  'input[placeholder*="job title" i]',
  'input[placeholder*="opportunity" i]',
  'input[placeholder*="job" i]',
  'input[placeholder*="keyword" i]',
  'input[placeholder*="role" i]',
  'input[aria-label*="job title" i]',
  'input[aria-label*="job" i]',
  'input[aria-label*="keyword" i]',
  'input[name*="query" i]',
  'input[name*="keyword" i]',
  'input[id*="position-query" i]',
  'input[id*="rad-search" i]',
  'input[id*="keyword" i]',
  'input[type="search"]',
  'input[name*="search" i]:not([name*="skill" i])',
  'input[id*="search" i]:not([id*="skill" i]):not([id*="search-box" i])',
  'input[placeholder*="search" i]:not([placeholder*="skill" i])',
  'input[aria-label*="search" i]:not([aria-label*="skill" i])',
  '[role="searchbox"]',
  '[role="combobox"][placeholder*="job" i]',
  '[role="combobox"][placeholder*="keyword" i]',
  '[role="combobox"][aria-label*="job" i]',
  '[role="combobox"][aria-label*="keyword" i]',
  '[role="combobox"][aria-label*="search" i]',
].join(", ");

const LOCATION_INPUT = [
  'input[id*="position-location" i]',
  'input[name*="location" i]',
  'input[name*="place" i]',
  'input[name*="city" i]',
  'input[id*="location" i]',
  'input[placeholder*="location" i]',
  'input[placeholder*="city" i]',
  'input[placeholder*="remote" i]',
  'input[placeholder*="zip" i]',
  'input[aria-label*="location" i]',
  'input[aria-label*="city" i]',
  '[role="combobox"][placeholder*="location" i]',
  '[role="combobox"][placeholder*="city" i]',
  '[role="combobox"][aria-label*="location" i]',
  '[role="searchbox"][placeholder*="location" i]',
].join(", ");

const SEARCH_SUBMIT =
  'button[type="submit"], input[type="submit"], button:has-text("Search"), button:has-text("Find"), button:has-text("Go"), button[aria-label*="Search" i], [role="button"]:has-text("Search"), [role="button"]:has-text("Go"), [role="button"][aria-label*="Search" i]';

/**
 * Eightfold-style shells that need a click before the real keyword input appears.
 * Keep as separate selectors (never comma-join): mixing `text=` / `:text()` into a
 * CSS list makes Playwright parse the whole string as CSS and throws on every page.
 * Prefer exact "FIND" so marketing CTAs like "FIND OUT MORE" are not clicked.
 */
const SEARCH_SHELL = [
  'button:text-is("FIND")',
  '[role="button"]:text-is("FIND")',
  "text=/^FIND$/i",
  '[class*="search" i]:has-text("Job title")',
  '[class*="search" i]:has-text("keyword")',
  ':text("Job title, skill, keyword")',
] as const;

const CONSENT_BUTTONS = [
  'button:has-text("Accept all")',
  'button:has-text("Accept All")',
  'button:has-text("ACCEPT ALL")',
  'button:has-text("Essential only")',
  'button:has-text("ESSENTIAL ONLY")',
  'button:has-text("Accept")',
  'button:has-text("Agree")',
  'button:has-text("Allow all")',
  'button:has-text("I agree")',
  "#onetrust-accept-btn-handler",
  '[id*="accept" i][class*="cookie" i]',
];

async function dismissConsent(page: Page): Promise<void> {
  for (const selector of CONSENT_BUTTONS) {
    const button = page.locator(selector).first();
    if ((await button.count()) === 0) continue;
    try {
      await button.click({ timeout: 1_500, force: true });
      return;
    } catch {
      // Try the next consent control.
    }
  }
  await page
    .evaluate(() => {
      document.querySelector("#__tealiumGDPRecModal")?.remove();
      document.querySelector(".onetrust-pc-dark-filter")?.remove();
    })
    .catch(() => undefined);
}

async function typeInto(locator: Locator, value: string): Promise<boolean> {
  try {
    await locator.click({ timeout: 2_000 });
  } catch {
    // Some comboboxes are already focused / not clickable.
  }
  try {
    await locator.fill(value, { timeout: 3_000 });
    return true;
  } catch {
    // Combobox / contenteditable fields often reject fill().
  }
  try {
    await locator.pressSequentially(value, { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

async function fillSearchIn(root: Page | Frame, keywords: string, location: string): Promise<boolean> {
  // Eightfold: click the FIND shell so the keyword input mounts.
  for (const selector of SEARCH_SHELL) {
    try {
      const shell = root.locator(selector).first();
      if ((await shell.count()) === 0) continue;
      await shell.click({ timeout: 1_500, force: true });
      break;
    } catch {
      // Try the next shell control — a bad selector must not abort the crawl.
    }
  }

  const search = root.locator(SEARCH_INPUT).first();
  if ((await search.count()) === 0) return false;
  if (!(await typeInto(search, keywords))) return false;

  if (location.trim()) {
    const place = root.locator(LOCATION_INPUT).first();
    if ((await place.count()) > 0) {
      await typeInto(place, location);
    }
  }

  const button = root.locator(SEARCH_SUBMIT).first();
  if ((await button.count()) > 0) {
    try {
      await Promise.all([
        root.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined),
        button.click({ timeout: 3_000, force: true }),
      ]);
      return true;
    } catch {
      // Fall through to Enter.
    }
  }
  try {
    await Promise.all([
      root.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined),
      search.press("Enter"),
    ]);
  } catch {
    return true;
  }
  return true;
}

async function fillSearch(page: Page, keywords: string, location: string): Promise<boolean> {
  try {
    if (await fillSearchIn(page, keywords, location)) return true;
  } catch {
    // Selector / navigation glitches must not mark every catalog row as error.
  }
  // Job boards embedded in iframes (Pereless, some ADP/Eightfold embeds).
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      if (await fillSearchIn(frame, keywords, location)) return true;
    } catch {
      // Cross-origin or detached frame — try the next one.
    }
  }
  return false;
}

function locationLabel(query: CareerSearchQuery): string {
  if (query.place.trim()) return query.place.trim();
  if (query.country.trim() && !/^(remote|apac|japac|emea|mea|americas|nordics)$/i.test(query.country)) {
    return countryName(query.country);
  }
  return "";
}

function toPostings(company: string, jobs: RawJob[]): CareerPagePosting[] {
  const postings: CareerPagePosting[] = [];
  const seen = new Set<string>();
  for (const job of jobs.slice(0, MAX_JOBS_PER_SITE)) {
    const url = job.url.slice(0, 2000);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const title = job.title.slice(0, 500);
    const place = job.place.slice(0, 300);
    const blob = `${place} ${title}`.toLowerCase();
    postings.push({
      externalId: `career-${createHash("sha256").update(`${company}\n${url}`).digest("hex").slice(0, 24)}`,
      title,
      company: company.slice(0, 300),
      place,
      remote: blob.includes("remote"),
      salary: "",
      postedAt: null,
      url,
      via: `Careers · ${company}`.slice(0, 100),
      description: job.description.slice(0, 100_000),
    });
  }
  return postings;
}

async function noteCrawl(
  company: CareerPageCompany,
  query: CareerSearchQuery,
  outcome: {
    status: BoardCrawlStatus;
    jobs: CareerPagePosting[];
    detail: string;
    method: "browser" | "api" | "cache";
    durationMs: number;
    /** False when the portal answered cleanly (including zero keyword matches). */
    openProblem?: boolean;
    samples?: string[];
  },
): Promise<void> {
  await recordBoardCrawl({
    url: company.url,
    company: company.name,
    status: outcome.status,
    hitCount: outcome.jobs.length,
    samples: (outcome.samples ?? outcome.jobs.slice(0, 5).map((job) => job.title)).slice(0, 5),
    detail: outcome.detail,
    keywords: query.keywords,
    place: query.place,
    country: query.country,
    method: outcome.method,
    durationMs: outcome.durationMs,
    openProblem: outcome.status === "ok" ? false : outcome.openProblem,
  });
}

/** Open one careers URL, search it, and return the jobs that show up. */
export async function searchCareerPage(
  company: CareerPageCompany,
  query: CareerSearchQuery,
  signal?: AbortSignal,
): Promise<CareerPagePosting[]> {
  if (signal?.aborted) throw signal.reason ?? new Error("aborted");
  const keywords = query.keywords.trim();
  if (!keywords) return [];
  const key = cacheKey(company.url, { ...query, keywords });
  const cached = await readCache(key);
  if (cached) {
    // Cache must still update Settings → Board crawl, or the UI stays empty
    // after a restart while the disk cache is warm.
    await noteCrawl(
      company,
      { ...query, keywords },
      {
        status: cached.length > 0 ? "ok" : "empty",
        jobs: cached,
        detail:
          cached.length > 0
            ? `Cached result: ${cached.length} listing${cached.length === 1 ? "" : "s"}.`
            : "Cached result: no listings for this search.",
        method: "cache",
        durationMs: 0,
        openProblem: false,
      },
    );
    return cached;
  }

  const location = locationLabel(query);
  const started = Date.now();
  const finish = async (
    jobs: CareerPagePosting[],
    status: BoardCrawlStatus,
    detail: string,
    method: "browser" | "api",
    openProblem?: boolean,
    samples?: string[],
  ) => {
    await writeCache(key, jobs);
    await noteCrawl(company, { ...query, keywords }, {
      status,
      jobs,
      detail,
      method,
      durationMs: Date.now() - started,
      openProblem,
      samples,
    });
    return jobs;
  };

  // Fast JSON paths when the host exposes a public jobs API for the same search.
  for (const attempt of [
    () => searchAccentureJobs(company.url, keywords, location, signal),
    () => searchPhenomJobs(company.url, keywords, location, signal),
  ]) {
    const apiJobs = await attempt();
    if (apiJobs) {
      const jobs = toPostings(company.name, apiJobs);
      return finish(
        jobs,
        jobs.length > 0 ? "ok" : "empty",
        jobs.length > 0 ? `Portal API returned ${jobs.length} listing${jobs.length === 1 ? "" : "s"}.` : "Portal API answered but returned no listings for this search.",
        "api",
        false,
      );
    }
  }

  await acquire();
  try {
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const context = await (await browser()).newContext({
      userAgent: USER_AGENT,
      locale: "en-US",
      extraHTTPHeaders: { "accept-language": "en-US,en;q=0.9" },
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(PAGE_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(GOTO_TIMEOUT_MS);
      const opened = await openCareersUrl(page, company.url);
      if (!opened.ok) {
        return finish(
          [],
          "error",
          opened.detail ||
            (opened.status ? `The careers page responded with HTTP ${opened.status}.` : "The careers page did not respond."),
          "browser",
          true,
        );
      }
      if (SETTLE_MS) await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      await dismissConsent(page);
      // Programme carousels (apprentice / undergrad / graduate) before any
      // search click — a loose "FIND" shell must not navigate away first.
      await revealProgrammeCarousels(page);
      // Location-only portals (e.g. JioSaavn Find Your Gig): filter offices first.
      const locationFiltered = await applyLocationFilter(page, location);
      // Brand / business-line scroll (e.g. InCred Finance → Capital → Wealth).
      const brandSweep = await sweepBrandCategoryFilters(page, page.url());
      // No search box yet — still bump page size / paginate and harvest cards.
      const listedBefore = mergeRawJobs(brandSweep.jobs, await collectAllListings(page, page.url()));
      const searched = await fillSearch(page, keywords, location);
      if (!searched) {
        // Ctrl+F-style match: direct tokens + nearby skill/role families.
        const matched = await filterJobsByQuery(listedBefore, keywords, signal);
        const jobs = toPostings(company.name, matched);
        if (jobs.length > 0) {
          return finish(
            jobs,
            "ok",
            locationFiltered
              ? `Location filter + in-page match returned ${jobs.length} listing${jobs.length === 1 ? "" : "s"}.`
              : brandSweep.used
                ? `Brand filter + in-page match returned ${jobs.length} listing${jobs.length === 1 ? "" : "s"}.`
                : `In-page match found ${jobs.length} listing${jobs.length === 1 ? "" : "s"} (no search field).`,
            "browser",
            false,
          );
        }
        if (listedBefore.length > 0) {
          const priorTitles = listedBefore
            .slice(0, 5)
            .map((job) => job.title.replace(/^more details(?:\s+about)?\s+/i, "").trim())
            .filter(Boolean);
          return finish(
            [],
            "empty",
            "Listings were on the page, but none matched this search (in-page / skill match).",
            "browser",
            false,
            priorTitles,
          );
        }
        if (locationFiltered || (await hasLocationJobFilter(page))) {
          return finish(
            [],
            "empty",
            "Location filter page has no open roles right now.",
            "browser",
            false,
          );
        }
        if (brandSweep.used) {
          return finish(
            [],
            "empty",
            "Brand filter page has no open roles right now.",
            "browser",
            false,
          );
        }
        return finish([], "empty", "No search field was found on this careers URL.", "browser", true);
      }
      if (AFTER_SEARCH_MS) await new Promise((resolve) => setTimeout(resolve, AFTER_SEARCH_MS));
      const raw = await collectAllListings(page, page.url());
      let jobs = toPostings(company.name, raw);
      if (jobs.length === 0) {
        // Portal search returned nothing useful — fall back to in-page / skill match
        // on whatever was listed before typing into the box.
        jobs = toPostings(company.name, await filterJobsByQuery(listedBefore, keywords, signal));
        if (jobs.length > 0) {
          return finish(
            jobs,
            "ok",
            `Search bar missed; in-page match kept ${jobs.length} listing${jobs.length === 1 ? "" : "s"}.`,
            "browser",
            false,
          );
        }
      }
      if (jobs.length > 0) {
        return finish(jobs, "ok", `Search bar returned ${jobs.length} listing${jobs.length === 1 ? "" : "s"}.`, "browser", false);
      }
      const priorTitles = listedBefore
        .slice(0, 5)
        .map((job) => job.title.replace(/^more details(?:\s+about)?\s+/i, "").trim())
        .filter(Boolean);
      // Soft-resolve only when the portal clearly rendered listings but none
      // matched this query. Zero links after a search still counts as a problem.
      return finish(
        [],
        "empty",
        priorTitles.length > 0
          ? "Search ran; listings were on the page, but none matched this query."
          : "Search ran, but no job links were found on the results page.",
        "browser",
        priorTitles.length === 0,
        priorTitles,
      );
    } finally {
      await context.close();
    }
  } catch (error) {
    if (process.env.FITBOARD_DEBUG_CAREERS) {
      console.error("searchCareerPage failed", company.url, error);
    }
    const detail = signal?.aborted
      ? "Crawl stopped before this page finished (time budget or cancel)."
      : error instanceof Error
        ? error.message.slice(0, 500)
        : "The careers page could not be searched.";
    return finish([], "error", detail, "browser", true);
  } finally {
    release();
  }
}

/**
 * Search every non-ATS careers page in the catalog. Failures are empty
 * lists; callers merge these with the ATS crawl.
 */
export async function searchOfficialCareers(
  companies: readonly CareerPageCompany[],
  query: CareerSearchQuery,
  signal?: AbortSignal,
): Promise<CareerPagePosting[]> {
  const keywords = query.keywords.trim();
  if (!keywords) return [];
  const normalized = { keywords, place: query.place, country: query.country };
  // One AI expansion for the whole crawl (cached) so every company sees the same related roles.
  await expandRelatedRoleTerms(keywords, signal).catch(() => []);
  const work = companies.map((company) => async () => searchCareerPage(company, normalized, signal));
  const results: PromiseSettledResult<CareerPagePosting[]>[] = new Array(work.length);
  let next = 0;
  async function worker() {
    while (next < work.length) {
      const index = next++;
      if (signal?.aborted) {
        results[index] = { status: "fulfilled", value: [] };
        continue;
      }
      try {
        results[index] = { status: "fulfilled", value: await work[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENT_PAGES, Math.max(work.length, 1)) }, () => worker()));
  const postings: CareerPagePosting[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (!result || result.status !== "fulfilled") continue;
    for (const job of result.value) {
      const key = job.url || job.externalId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      postings.push(job);
    }
  }
  return postings;
}

/** Test hook: clear the in-memory browser pool after stubbing Playwright. */
export function resetCareerSearchPoolForTests(): void {
  pool.browser = null;
  pool.active = 0;
  pool.queue = [];
  if (pool.idleTimer) clearTimeout(pool.idleTimer);
  pool.idleTimer = null;
}
