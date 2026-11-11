/**
 * Find real careers URLs for companies in config/job-boards.json that still
 * point at a marketing homepage.
 *
 * Strategy (no hard-coded company list):
 *  1. Fetch the current URL and pick the strongest careers/jobs link on it
 *     (ATS hosts like Zoho Recruit / Greenhouse win).
 *  2. If that fails, try DuckDuckGo HTML for `"{name}" careers` and pick a
 *     result that looks like a careers portal for that company.
 *
 * Usage:
 *   FITBOARD_DATA_DIR=./tmp/data node --import tsx scripts/discover-career-urls.ts
 *   DISCOVER_LIMIT=50 DISCOVER_APPLY=1 node --import tsx scripts/discover-career-urls.ts
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import catalog from "../config/job-boards.json";

type Company = { name: string; url: string; sector: string };

type Discovery = {
  name: string;
  from: string;
  to: string | null;
  sector: string;
  via: "homepage-link" | "search" | "unchanged" | "failed";
  detail: string;
};

const USER_AGENT = "Fitboard/1.0 (career URL discovery)";
const TIMEOUT_MS = 15_000;
const CONCURRENCY = Number(process.env.DISCOVER_CONCURRENCY || 8);
const LIMIT = process.env.DISCOVER_LIMIT ? Number(process.env.DISCOVER_LIMIT) : null;
const APPLY = process.env.DISCOVER_APPLY === "1";
const ONLY = (process.env.DISCOVER_ONLY || "").trim().toLowerCase();

const ATS_HOST =
  /(?:^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|recruitee\.com|smartrecruiters\.com|myworkdayjobs\.com|zohorecruit\.(?:in|com)|icims\.com|jobvite\.com|bamboohr\.com|workable\.com|ripplehire\.com|successfactors\.com|eightfold\.ai|phenom\.com|taleo\.net)\b/i;

const CAREER_PATH = /\/(careers?|jobs?|talent|recruit|hiring|vacancies|openings|join-?us|work-?with-?us|opportunit)(\/|$)/i;

function isAtsOrCareerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathName = parsed.pathname;
    if (ATS_HOST.test(host)) return true;
    if (CAREER_PATH.test(pathName) || /(?:^|\.)(careers?|jobs?)\./i.test(host)) return true;
    return false;
  } catch {
    return false;
  }
}

function looksLikeHomepage(row: Company): boolean {
  if (isAtsOrCareerUrl(row.url)) return false;
  try {
    const parsed = new URL(row.url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts.length <= 1;
  } catch {
    return true;
  }
}

function absoluteUrl(href: string, base: string): string | null {
  try {
    const url = new URL(href, base);
    if (!/^https?:$/i.test(url.protocol)) return null;
    url.hash = "";
    // Drop tracker noise from career portal links.
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|hsa_|__hs|fbclid|gclid|mc_)/i.test(key) || key.startsWith("__")) url.searchParams.delete(key);
    }
    return url.toString().replace(/\?$/, "");
  } catch {
    return null;
  }
}

function companyTokens(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !/^(the|and|inc|ltd|llc|corp|com|www)$/i.test(token));
}

function urlMentionsCompany(url: string, name: string): boolean {
  const blob = url.toLowerCase();
  return companyTokens(name).some((token) => blob.includes(token));
}

function scoreCareerCandidate(url: string, companyName: string): number {
  let score = 0;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const pathName = parsed.pathname.toLowerCase();
    if (ATS_HOST.test(host)) score += 100;
    if (/zohorecruit/i.test(host)) score += 20;
    if (CAREER_PATH.test(pathName)) score += 40;
    if (/(?:^|\.)(careers?|jobs?)\./i.test(host)) score += 50;
    const token = companyName.toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (token && host.replace(/[^a-z0-9]+/g, "").includes(token.slice(0, Math.min(8, token.length)))) score += 15;
    if (/linkedin\.com|indeed\.com|glassdoor\.com|naukrigulf|naukri\.com|instagram\.com|facebook\.com|twitter\.com|x\.com|youtube\.com/i.test(host)) {
      score -= 80;
    }
    if (pathName === "/" || pathName === "") score -= 30;
  } catch {
    return -100;
  }
  return score;
}

function extractLinks(html: string, base: string): string[] {
  const links: string[] = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(re)) {
    const abs = absoluteUrl(match[1], base);
    if (abs) links.push(abs);
  }
  return [...new Set(links)];
}

async function fetchText(url: string): Promise<{ ok: boolean; finalUrl: string; status: number; text: string }> {
  const response = await fetch(url, {
    headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
    redirect: "follow",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await response.text();
  return { ok: response.ok, finalUrl: response.url || url, status: response.status, text };
}

function pickBest(links: string[], companyName: string, minScore = 40): string | null {
  let best: { url: string; score: number } | null = null;
  for (const link of links) {
    const score = scoreCareerCandidate(link, companyName);
    if (score < minScore) continue;
    if (!best || score > best.score) best = { url: link, score };
  }
  return best?.url ?? null;
}

async function discoverFromHomepage(row: Company): Promise<Discovery | null> {
  try {
    const page = await fetchText(row.url);
    const links = extractLinks(page.text, page.finalUrl);
    const best = pickBest(links, row.name, 40);
    if (!best || best.replace(/\/$/, "") === row.url.replace(/\/$/, "")) return null;
    return {
      name: row.name,
      from: row.url,
      to: best,
      sector: row.sector,
      via: "homepage-link",
      detail: `Found on ${page.finalUrl}`,
    };
  } catch (error) {
    return {
      name: row.name,
      from: row.url,
      to: null,
      sector: row.sector,
      via: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function discoverFromSearch(row: Company): Promise<Discovery | null> {
  const query = `"${row.name}" careers OR jobs (zohorecruit OR greenhouse OR lever OR ashby OR workday OR careers)`;
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const page = await fetchText(searchUrl);
    const links = extractLinks(page.text, page.finalUrl)
      // DuckDuckGo wraps outbound links.
      .map((link) => {
        try {
          const parsed = new URL(link);
          const uddg = parsed.searchParams.get("uddg");
          return uddg ? decodeURIComponent(uddg) : link;
        } catch {
          return link;
        }
      })
      .filter((link) => !/duckduckgo\.com/i.test(link))
      // Search results must mention the company — avoid albert2005.co.jp → albert.com.
      .filter((link) => urlMentionsCompany(link, row.name) || ATS_HOST.test(link));
    const named = links.filter((link) => urlMentionsCompany(link, row.name));
    const best = pickBest(named.length > 0 ? named : links, row.name, 55);
    if (!best || !urlMentionsCompany(best, row.name)) return null;
    return {
      name: row.name,
      from: row.url,
      to: best,
      sector: row.sector,
      via: "search",
      detail: `DuckDuckGo query for ${row.name} careers`,
    };
  } catch (error) {
    return {
      name: row.name,
      from: row.url,
      to: null,
      sector: row.sector,
      via: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        out[index] = await worker(items[index], index);
      }
    }),
  );
  return out;
}

async function main() {
  const companies = (catalog.companies as Company[]).filter((row) => row.name && row.url);
  let targets = companies.filter(looksLikeHomepage);
  if (ONLY) targets = targets.filter((row) => row.name.toLowerCase().includes(ONLY));
  if (LIMIT != null) targets = targets.slice(0, LIMIT);

  console.log(`Discovering careers URLs for ${targets.length} homepage-like catalog rows…`);
  const discoveries = await mapPool(targets, CONCURRENCY, async (row, index) => {
    if ((index + 1) % 25 === 0 || index === 0) console.log(`  ${index + 1}/${targets.length} ${row.name}`);
    const fromHome = await discoverFromHomepage(row);
    if (fromHome?.to) return fromHome;
    const fromSearch = await discoverFromSearch(row);
    if (fromSearch?.to) return fromSearch;
    return (
      fromHome ??
      fromSearch ?? {
        name: row.name,
        from: row.url,
        to: null,
        sector: row.sector,
        via: "unchanged" as const,
        detail: "No careers URL found",
      }
    );
  });

  const updates = discoveries.filter((row) => row.to && row.to !== row.from);
  const outDir = path.resolve(process.env.FITBOARD_DATA_DIR || "./tmp/data");
  await mkdir(outDir, { recursive: true });
  const reportPath = path.join(outDir, "career-url-discovery.json");
  await writeFile(
    reportPath,
    JSON.stringify(
      {
        checked: targets.length,
        updated: updates.length,
        updates,
        all: discoveries,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${reportPath} (${updates.length} updates).`);

  if (APPLY && updates.length > 0) {
    const file = path.resolve("config/job-boards.json");
    const raw = await readFile(file, "utf8");
    const json = JSON.parse(raw) as { companies: Company[] };
    const byName = new Map(updates.map((row) => [row.name, row]));
    let changed = 0;
    json.companies = json.companies.map((row) => {
      const update = byName.get(row.name);
      if (!update?.to || row.url !== update.from) return row;
      changed += 1;
      return { ...row, url: update.to };
    });
    await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
    console.log(`Applied ${changed} URL updates to config/job-boards.json`);
  } else if (!APPLY) {
    console.log("Dry run only. Re-run with DISCOVER_APPLY=1 to write config/job-boards.json.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
