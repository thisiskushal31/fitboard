import "server-only";

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { env } from "@/lib/core/env";
import { logServerError } from "@/lib/core/log";

import { loadJobSearchConfig } from "./config";
import { requestJson } from "./http";
import { formatSalaryRange, type ParsedSalary } from "./salary";
import {
  currencyForCountry,
  enabledSalarySources,
  sourceCoversCountry,
  type SalarySourceConfig,
} from "./salary-sources";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PAYCRUNCH_INDEX_TTL_MS = 24 * 60 * 60 * 1000;

export type MarketSalary = {
  currency: string;
  /** Approximate lower quartile, when available. */
  p25: number | null;
  median: number;
  /** Approximate upper quartile, when available. */
  p75: number | null;
  label: string;
  /** Source id from config/salary-sources.json. */
  source: string;
  sourceLabel: string;
  attributionUrl: string;
  /** How the figure was derived. */
  detail: string;
};

type CacheEntry = { at: number; market: MarketSalary | null };

type PayCrunchJob = { slug: string; name: string; median: number | null; estimated?: boolean };

const histogramSchema = z.object({
  histogram: z.record(z.string(), z.union([z.string(), z.number()])).optional().catch(undefined),
});

const historySchema = z.object({
  month: z.record(z.string(), z.union([z.string(), z.number()])).optional().catch(undefined),
});

const payCrunchIndexSchema = z.object({
  jobs: z
    .array(
      z.object({
        slug: z.string(),
        name: z.string(),
        median: z.number().nullable().optional().catch(null),
        estimated: z.boolean().optional().catch(false),
      }),
    )
    .default([]),
});

const payCrunchJobSchema = z.object({
  name: z.string().optional().catch(""),
  estimated: z.boolean().optional().catch(false),
  source_release: z.string().optional().catch(""),
  url: z.string().optional().catch(""),
  wage: z
    .object({
      currency: z.string().optional().catch("USD"),
      p25: z.number().nullable().optional().catch(null),
      median: z.number().nullable().optional().catch(null),
      p75: z.number().nullable().optional().catch(null),
    })
    .optional()
    .catch(undefined),
});

let payCrunchIndexMemory: { at: number; jobs: PayCrunchJob[] } | null = null;

function cacheDir(): string {
  return path.join(env.FITBOARD_DATA_DIR, "salary-market-cache");
}

function cacheKey(title: string, country: string, place: string): string {
  return createHash("sha256").update(JSON.stringify({ title: title.trim().toLowerCase(), country, place: place.trim().toLowerCase() })).digest("hex");
}

async function readCache(key: string): Promise<MarketSalary | null | undefined> {
  try {
    const raw = await readFile(path.join(cacheDir(), `${key}.json`), "utf8");
    const entry = JSON.parse(raw) as CacheEntry;
    if (!entry || typeof entry.at !== "number") return undefined;
    if (Date.now() - entry.at > CACHE_TTL_MS) return undefined;
    return entry.market;
  } catch {
    return undefined;
  }
}

async function writeCache(key: string, market: MarketSalary | null): Promise<void> {
  try {
    await mkdir(cacheDir(), { recursive: true });
    const entry: CacheEntry = { at: Date.now(), market };
    await writeFile(path.join(cacheDir(), `${key}.json`), JSON.stringify(entry));
  } catch {
    // Best-effort.
  }
}

function weightedPercentile(points: { salary: number; count: number }[], percentile: number): number | null {
  const total = points.reduce((sum, point) => sum + point.count, 0);
  if (total <= 0) return null;
  const target = (percentile / 100) * total;
  let seen = 0;
  for (const point of points) {
    seen += point.count;
    if (seen >= target) return point.salary;
  }
  return points[points.length - 1]?.salary ?? null;
}

function marketBand(
  currency: string,
  p25: number | null,
  median: number,
  p75: number | null,
  source: SalarySourceConfig,
  detail: string,
): MarketSalary {
  const low = p25 ?? median;
  const high = p75 ?? median;
  return {
    currency,
    p25,
    median,
    p75,
    label: formatSalaryRange(low, high, currency),
    source: source.id,
    sourceLabel: source.label,
    attributionUrl: source.attributionUrl,
    detail,
  };
}

function fromHistogram(histogram: Record<string, string | number>, currency: string, source: SalarySourceConfig): MarketSalary | null {
  const points = Object.entries(histogram)
    .map(([salary, vacancies]) => ({ salary: Number(salary), count: Number(vacancies) }))
    .filter((point) => Number.isFinite(point.salary) && point.salary > 0 && Number.isFinite(point.count) && point.count > 0)
    .sort((a, b) => a.salary - b.salary);
  if (points.length === 0) return null;
  const p25 = weightedPercentile(points, 25);
  const median = weightedPercentile(points, 50);
  const p75 = weightedPercentile(points, 75);
  if (median == null) return null;
  return marketBand(currency, p25, median, p75, source, `${source.label} salary distribution for this role.`);
}

function fromHistory(month: Record<string, string | number>, currency: string, source: SalarySourceConfig): MarketSalary | null {
  const values = Object.values(month)
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  if (values.length === 0) return null;
  const median = values.reduce((sum, value) => sum + value, 0) / values.length;
  return marketBand(currency, null, median, null, source, `${source.label} average salary over recent months for this role.`);
}

async function fetchAdzunaMarket(
  source: SalarySourceConfig,
  input: { title: string; place: string; country: string; signal?: AbortSignal },
): Promise<MarketSalary | null> {
  const config = await loadJobSearchConfig();
  const appId = config.adzuna.appId.trim();
  const appKey = config.adzuna.key?.trim() ?? "";
  if (!appId || !appKey) return null;

  const currency = source.currencies?.[input.country] || currencyForCountry(input.country) || "USD";
  const baseUrl = (env.FITBOARD_JOBS_TEST_BASE_URL?.replace(/\/+$/, "") || source.baseUrl || "").replace(/\/+$/, "");
  if (!baseUrl) return null;

  const histogramUrl = new URL(`${baseUrl}/${input.country}/histogram`);
  histogramUrl.searchParams.set("app_id", appId);
  histogramUrl.searchParams.set("app_key", appKey);
  histogramUrl.searchParams.set("what", input.title);
  if (input.place) histogramUrl.searchParams.set("where", input.place);
  const histogramRaw = histogramSchema.safeParse(await requestJson("ADZUNA", histogramUrl, { signal: input.signal }));
  if (histogramRaw.success && histogramRaw.data.histogram) {
    const market = fromHistogram(histogramRaw.data.histogram, currency, source);
    if (market) return market;
  }

  const historyUrl = new URL(`${baseUrl}/${input.country}/history`);
  historyUrl.searchParams.set("app_id", appId);
  historyUrl.searchParams.set("app_key", appKey);
  historyUrl.searchParams.set("what", input.title);
  historyUrl.searchParams.set("months", "12");
  if (input.place) historyUrl.searchParams.set("where", input.place);
  const historyRaw = historySchema.safeParse(await requestJson("ADZUNA", historyUrl, { signal: input.signal }));
  if (historyRaw.success && historyRaw.data.month) {
    return fromHistory(historyRaw.data.month, currency, source);
  }
  return null;
}

function normalizeTitleTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 1 && !/^(the|and|for|with|senior|junior|staff|principal|lead|remote)$/.test(token));
}

/** URL slug candidates for a job title (full title, then token-stripped). */
export function titleSlugCandidates(title: string): string[] {
  const full = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const stripped = normalizeTitleTokens(title).join("-");
  return [...new Set([full, stripped].filter(Boolean))];
}

/** Dynamic title match against a catalog of occupation names — no alias table. */
export function scoreOccupationTitle(query: string, occupationName: string): number {
  const q = normalizeTitleTokens(query);
  const n = normalizeTitleTokens(occupationName);
  if (q.length === 0 || n.length === 0) return 0;
  const qJoined = q.join(" ");
  const nJoined = n.join(" ");
  if (qJoined === nJoined) return 100;
  if (nJoined.includes(qJoined) || qJoined.includes(nJoined)) return 85;
  const nSet = new Set(n);
  const overlap = q.filter((token) => nSet.has(token)).length;
  if (overlap === 0) return 0;
  const coverage = overlap / Math.max(q.length, n.length);
  const exactish = overlap === q.length ? 15 : 0;
  return Math.round(coverage * 70 + exactish);
}

function envApiKey(name: string | undefined): string {
  if (!name) return "";
  if (name === "FITBOARD_GLASSDOOR_API_KEY") return env.FITBOARD_GLASSDOOR_API_KEY?.trim() ?? "";
  return (typeof process !== "undefined" ? process.env[name] : undefined)?.trim() ?? "";
}

async function loadPayCrunchIndex(source: SalarySourceConfig, signal?: AbortSignal): Promise<PayCrunchJob[]> {
  if (payCrunchIndexMemory && Date.now() - payCrunchIndexMemory.at < PAYCRUNCH_INDEX_TTL_MS) {
    return payCrunchIndexMemory.jobs;
  }
  const indexPath = path.join(cacheDir(), "paycrunch-jobs-index.json");
  try {
    const raw = await readFile(indexPath, "utf8");
    const entry = JSON.parse(raw) as { at: number; jobs: PayCrunchJob[] };
    if (entry?.at && Date.now() - entry.at < PAYCRUNCH_INDEX_TTL_MS && Array.isArray(entry.jobs)) {
      payCrunchIndexMemory = entry;
      return entry.jobs;
    }
  } catch {
    // fetch fresh
  }

  if (!source.jobsIndexUrl) throw new Error("PayCrunch source is missing jobsIndexUrl in config.");
  const response = await fetch(source.jobsIndexUrl, {
    headers: { accept: "application/json", "user-agent": "Fitboard/1.0 (salary market)" },
    signal: signal ?? AbortSignal.timeout(45_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`PayCrunch jobs index HTTP ${response.status}`);
  const parsed = payCrunchIndexSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("PayCrunch jobs index shape changed.");
  const jobs = parsed.data.jobs.map((job) => ({
    slug: job.slug,
    name: job.name,
    median: job.median ?? null,
    estimated: Boolean(job.estimated),
  }));
  payCrunchIndexMemory = { at: Date.now(), jobs };
  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(indexPath, JSON.stringify(payCrunchIndexMemory));
  } catch {
    // Best-effort disk cache.
  }
  return jobs;
}

async function fetchPayCrunchMarket(
  source: SalarySourceConfig,
  input: { title: string; signal?: AbortSignal },
): Promise<MarketSalary | null> {
  const jobs = await loadPayCrunchIndex(source, input.signal);
  let best: { job: PayCrunchJob; score: number } | null = null;
  for (const job of jobs) {
    const score = scoreOccupationTitle(input.title, job.name);
    if (score < 55) continue;
    if (!best || score > best.score) best = { job, score };
  }
  if (!best) return null;

  const template = source.jobUrlTemplate || "";
  const jobUrl = template.includes("{slug}") ? template.replace("{slug}", encodeURIComponent(best.job.slug)) : "";
  if (!jobUrl) return null;

  const response = await fetch(jobUrl, {
    headers: { accept: "application/json", "user-agent": "Fitboard/1.0 (salary market)" },
    signal: input.signal ?? AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`PayCrunch job HTTP ${response.status}`);
  const parsed = payCrunchJobSchema.safeParse(await response.json());
  const wage = parsed.success ? parsed.data.wage : undefined;
  const median = wage?.median;
  if (!parsed.success || median == null) return null;
  const currency = wage?.currency || source.currency || "USD";
  const release = parsed.data.source_release || (parsed.data.estimated ? "estimate" : "BLS OEWS");
  return marketBand(
    currency,
    wage?.p25 ?? null,
    median,
    wage?.p75 ?? null,
    source,
    `${source.label}: ${parsed.data.name || best.job.name} (${release}).`,
  );
}

const ambitionBoxProfileSchema = z.object({
  props: z.object({
    pageProps: z.object({
      salaryData: z
        .object({
          profileSalaryData: z
            .object({
              jobProfileName: z.string().optional().catch(""),
              medianCtc: z.number().nullable().optional().catch(null),
              typicalMinCtc: z.number().nullable().optional().catch(null),
              typicalMaxCtc: z.number().nullable().optional().catch(null),
              percentiles: z
                .object({
                  percentile25: z.number().nullable().optional().catch(null),
                  percentile75: z.number().nullable().optional().catch(null),
                })
                .optional()
                .catch(undefined),
            })
            .optional()
            .catch(undefined),
        })
        .optional()
        .catch(undefined),
    }),
  }),
});

/** AmbitionBox designation salary pages embed ranges in __NEXT_DATA__. */
export async function fetchAmbitionBoxMarket(
  source: SalarySourceConfig,
  input: { title: string; place?: string; signal?: AbortSignal },
): Promise<MarketSalary | null> {
  const template = source.profileUrlTemplate || "";
  if (!template.includes("{slug}")) throw new Error("AmbitionBox source is missing profileUrlTemplate with {slug}.");
  const currency = source.currency || "INR";
  const placeSlug = (input.place || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  for (const slug of titleSlugCandidates(input.title)) {
    const url = new URL(template.replace("{slug}", encodeURIComponent(slug)));
    if (placeSlug) url.searchParams.set("location", placeSlug);
    const response = await fetch(url, {
      headers: {
        accept: "text/html",
        "user-agent": "Mozilla/5.0 (compatible; Fitboard/1.0; salary market)",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: input.signal ?? AbortSignal.timeout(30_000),
      cache: "no-store",
      redirect: "follow",
    });
    if (!response.ok) continue;
    const html = await response.text();
    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!match?.[1]) continue;
    const parsed = ambitionBoxProfileSchema.safeParse(JSON.parse(match[1]));
    const profile = parsed.success ? parsed.data.props.pageProps.salaryData?.profileSalaryData : undefined;
    const median = profile?.medianCtc;
    if (median == null || !Number.isFinite(median) || median <= 0) continue;
    const p25 = profile?.percentiles?.percentile25 ?? profile?.typicalMinCtc ?? null;
    const p75 = profile?.percentiles?.percentile75 ?? profile?.typicalMaxCtc ?? null;
    return marketBand(
      currency,
      p25,
      median,
      p75,
      source,
      `${source.label}: ${profile?.jobProfileName || input.title} (India CTC).`,
    );
  }
  return null;
}

function glassdoorPageUrl(source: SalarySourceConfig, title: string): string | null {
  const template = source.pageUrlTemplate || "";
  if (!template.includes("{slug}")) return null;
  const slug = titleSlugCandidates(title)[0];
  if (!slug) return null;
  return template.replaceAll("{slug}", encodeURIComponent(slug)).replaceAll("{length}", String(slug.length));
}

function parseGlassdoorApiPayload(payload: unknown, source: SalarySourceConfig, title: string): MarketSalary | null {
  const root = payload as {
    estimate?: { median?: number; p25?: number; p75?: number; currency?: string; min?: number; max?: number };
    salary_estimate?: { median_salary?: number; min_salary?: number; max_salary?: number; salary_currency?: string };
    data?: { median?: number; p25?: number; p75?: number; currency?: string };
    median?: number;
    currency?: string;
  };
  const estimate = root.estimate || root.data;
  const legacy = root.salary_estimate;
  const median = estimate?.median ?? legacy?.median_salary ?? root.median;
  if (median == null || !Number.isFinite(median) || median <= 0) return null;
  const p25 = estimate?.p25 ?? legacy?.min_salary ?? null;
  const p75 = estimate?.p75 ?? legacy?.max_salary ?? null;
  const currency = estimate?.currency || legacy?.salary_currency || source.currency || "USD";
  return marketBand(currency, p25, median, p75, source, `${source.label}: ${title}.`);
}

async function fetchGlassdoorViaApi(
  source: SalarySourceConfig,
  input: { title: string; place: string; signal?: AbortSignal },
): Promise<MarketSalary | null> {
  const template = source.apiUrlTemplate || "";
  const key = envApiKey(source.apiKeyEnv);
  if (!template || !key) return null;
  const url = template
    .replaceAll("{title}", encodeURIComponent(input.title))
    .replaceAll("{place}", encodeURIComponent(input.place));
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "Fitboard/1.0 (salary market)",
      "x-api-key": key,
    },
    signal: input.signal ?? AbortSignal.timeout(45_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Glassdoor API HTTP ${response.status}`);
  return parseGlassdoorApiPayload(await response.json(), source, input.title);
}

/** Best-effort parse of Glassdoor HTML / embedded JSON for a total-pay band. */
export function parseGlassdoorSalaryHtml(html: string, source: SalarySourceConfig, title: string): MarketSalary | null {
  if (!html || /Security \| Glassdoor/i.test(html)) return null;
  const currency = source.currency || "USD";

  const jsonCandidates = [
    ...html.matchAll(/"median(?:Total|Base)?Pay"\s*:\s*(\d+(?:\.\d+)?)/gi),
    ...html.matchAll(/"percentile50"\s*:\s*(\d+(?:\.\d+)?)/gi),
    ...html.matchAll(/"estimatedSalary"\s*:\s*\{[^}]{0,400}?"(?:median|percentile50)"\s*:\s*(\d+(?:\.\d+)?)/gi),
  ];
  const medians = jsonCandidates.map((match) => Number(match[1])).filter((value) => Number.isFinite(value) && value > 1000);
  const median = medians[0];
  if (median == null) return null;

  const p25Match = html.match(/"percentile25"\s*:\s*(\d+(?:\.\d+)?)/i) || html.match(/"p25"\s*:\s*(\d+(?:\.\d+)?)/i);
  const p75Match = html.match(/"percentile75"\s*:\s*(\d+(?:\.\d+)?)/i) || html.match(/"p75"\s*:\s*(\d+(?:\.\d+)?)/i);
  const p25 = p25Match ? Number(p25Match[1]) : null;
  const p75 = p75Match ? Number(p75Match[1]) : null;
  return marketBand(
    currency,
    p25 != null && Number.isFinite(p25) ? p25 : null,
    median,
    p75 != null && Number.isFinite(p75) ? p75 : null,
    source,
    `${source.label}: ${title}.`,
  );
}

async function fetchGlassdoorViaPage(
  source: SalarySourceConfig,
  input: { title: string; signal?: AbortSignal },
): Promise<MarketSalary | null> {
  const pageUrl = glassdoorPageUrl(source, input.title);
  if (!pageUrl) throw new Error("Glassdoor source is missing pageUrlTemplate with {slug}.");

  // Fetch-only: do not pull playwright-core into the Next/Turbopack graph here —
  // a dynamic import on every Pay & Risk load was forcing endless recompiles.
  const response = await fetch(pageUrl, {
    headers: {
      accept: "text/html",
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "accept-language": "en-US,en;q=0.9",
    },
    signal: input.signal ?? AbortSignal.timeout(12_000),
    cache: "no-store",
    redirect: "follow",
  });
  if (!response.ok) return null;
  return parseGlassdoorSalaryHtml(await response.text(), source, input.title);
}

async function fetchGlassdoorMarket(
  source: SalarySourceConfig,
  input: { title: string; place: string; signal?: AbortSignal },
): Promise<MarketSalary | null> {
  const viaApi = await fetchGlassdoorViaApi(source, input).catch((error) => {
    logServerError("marketSalary:glassdoor-api", error);
    return null;
  });
  if (viaApi) return viaApi;
  return fetchGlassdoorViaPage(source, input);
}

/**
 * Market pay for a role. Tries each enabled source in config/salary-sources.json
 * that covers the country; first successful result wins. Failures are skipped.
 */
export async function marketSalaryForRole(input: {
  title: string;
  place?: string;
  country: string;
  signal?: AbortSignal;
}): Promise<MarketSalary | null> {
  const title = input.title.trim();
  const country = input.country.trim().toLowerCase();
  const place = (input.place ?? "").trim();
  if (!title || !country) return null;

  const key = cacheKey(title, country, place);
  const cached = await readCache(key);
  if (cached !== undefined) return cached;

  for (const source of enabledSalarySources()) {
    if (!sourceCoversCountry(source, country)) continue;
    try {
      let market: MarketSalary | null = null;
      if (source.kind === "adzuna") {
        market = await fetchAdzunaMarket(source, { title, place, country, signal: input.signal });
      } else if (source.kind === "ambitionbox") {
        market = await fetchAmbitionBoxMarket(source, { title, place, signal: input.signal });
      } else if (source.kind === "glassdoor") {
        market = await fetchGlassdoorMarket(source, { title, place, signal: input.signal });
      } else if (source.kind === "paycrunch") {
        market = await fetchPayCrunchMarket(source, { title, signal: input.signal });
      }
      if (market) {
        await writeCache(key, market);
        return market;
      }
    } catch (error) {
      logServerError(`marketSalary:${source.id}`, error);
    }
  }

  await writeCache(key, null);
  return null;
}

/** Compare an offer against market median when both exist. */
export function offerVsMarket(offer: ParsedSalary | null, market: MarketSalary | null): string | null {
  if (!offer || !market) return null;
  if (offer.currency && market.currency && offer.currency !== market.currency) return null;
  const delta = ((offer.mid - market.median) / market.median) * 100;
  if (Math.abs(delta) < 5) return "About in line with the market median.";
  if (delta > 0) return `About ${Math.round(delta)}% above the market median.`;
  return `About ${Math.round(Math.abs(delta))}% below the market median.`;
}

/** @deprecated Prefer currencyForCountry from salary-sources; kept for older imports. */
export const ADZUNA_CURRENCIES: Record<string, string> = Object.fromEntries(
  enabledSalarySources().flatMap((source) => Object.entries(source.currencies ?? {})),
);
