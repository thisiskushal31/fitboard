/**
 * Hit every company URL in config/job-boards.json and classify whether Fitboard
 * can crawl it today (ATS JSON, browser career search, or neither).
 *
 * Usage: node --import tsx scripts/probe-job-boards.ts
 * Optional: PROBE_LIMIT=50 PROBE_CONCURRENCY=20
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import catalog from "../config/job-boards.json";

type Handler =
  | "greenhouse"
  | "lever"
  | "ashby"
  | "recruitee"
  | "smartrecruiters"
  | "workday"
  | "career-browser"
  | "unhandled";

type Row = {
  name: string;
  url: string;
  sector: string;
  handler: Handler;
  ok: boolean;
  status: number | null;
  finalUrl: string | null;
  error: string | null;
  /** ATS API answered, or career HTML looks searchable / has job links / embeds a known ATS. */
  usable: boolean;
  notes: string[];
};

const USER_AGENT = "Fitboard/1.0 (catalog probe)";
const TIMEOUT_MS = 12_000;
const CONCURRENCY = Number(process.env.PROBE_CONCURRENCY || 24);
const LIMIT = process.env.PROBE_LIMIT ? Number(process.env.PROBE_LIMIT) : null;

function classify(url: string): Handler {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "unhandled";
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
    return "greenhouse";
  }
  if (host === "jobs.lever.co" && slug) return "lever";
  if (host === "jobs.ashbyhq.com" && slug) return "ashby";
  if (host.endsWith(".recruitee.com") && host !== "recruitee.com") return "recruitee";
  if (host === "jobs.smartrecruiters.com" && slug) return "smartrecruiters";
  if (host.endsWith(".myworkdayjobs.com") && (parts[0] || parts[1])) return "workday";
  return "career-browser";
}

function detectEmbeddedAts(finalUrl: string, html: string): string | null {
  const blob = `${finalUrl}\n${html}`;
  if (/boards(?:-api)?\.greenhouse\.io|job-boards\.greenhouse\.io/i.test(blob)) return "greenhouse";
  if (/jobs\.lever\.co/i.test(blob)) return "lever";
  if (/jobs\.ashbyhq\.com|api\.ashbyhq\.com/i.test(blob)) return "ashby";
  if (/myworkdayjobs\.com|\/wday\/cxs\//i.test(blob)) return "workday";
  if (/jobs\.smartrecruiters\.com|api\.smartrecruiters\.com/i.test(blob)) return "smartrecruiters";
  if (/\.recruitee\.com/i.test(blob)) return "recruitee";
  return null;
}

function careerLooksUsable(html: string, finalUrl: string): { usable: boolean; notes: string[] } {
  const notes: string[] = [];
  const embedded = detectEmbeddedAts(finalUrl, html);
  if (embedded) {
    notes.push(`page embeds or redirects toward ${embedded}`);
    return { usable: true, notes };
  }
  const hasSearch =
    /<input[^>]+type=["']search["']/i.test(html) ||
    /<input[^>]+(name|id|placeholder|aria-label)=["'][^"']*(search|query|keyword|job)[^"']*["']/i.test(html);
  const hasJobLink =
    /href=["'][^"']*\/careers?\/job[^"']*["']/i.test(html) ||
    /href=["'][^"']*\/jobs?\/[^"'\s#]+["']/i.test(html) ||
    /href=["'][^"']*\/job\/[^"'\s#]+["']/i.test(html) ||
    /application\/ld\+json[^>]*>[\s\S]*?"@type"\s*:\s*"JobPosting"/i.test(html);
  if (hasSearch) notes.push("has search field");
  if (hasJobLink) notes.push("has job links or JobPosting JSON-LD");
  if (!hasSearch && !hasJobLink) notes.push("no search field and no obvious job links");
  return { usable: hasSearch || hasJobLink, notes };
}

async function fetchText(url: string): Promise<{ status: number; finalUrl: string; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/json,*/*" },
    });
    const body = await response.text();
    return { status: response.status, finalUrl: response.url, body: body.slice(0, 400_000) };
  } finally {
    clearTimeout(timer);
  }
}

async function probeAts(handler: Handler, url: string): Promise<{ usable: boolean; notes: string[]; status: number | null; finalUrl: string | null; error: string | null }> {
  const notes: string[] = [];
  try {
    if (handler === "greenhouse") {
      const slug = new URL(url).pathname.split("/").filter(Boolean)[0];
      const api = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(slug!)}/jobs`;
      const res = await fetchText(api);
      const usable = res.status === 200 && /"jobs"\s*:/.test(res.body);
      if (!usable) notes.push(`greenhouse API ${res.status}`);
      else notes.push("greenhouse API ok");
      return { usable, notes, status: res.status, finalUrl: res.finalUrl, error: null };
    }
    if (handler === "lever") {
      const slug = new URL(url).pathname.split("/").filter(Boolean)[0];
      const api = `https://api.lever.co/v0/postings/${encodeURIComponent(slug!)}?mode=json`;
      const res = await fetchText(api);
      const usable = res.status === 200 && res.body.trimStart().startsWith("[");
      if (!usable) notes.push(`lever API ${res.status}`);
      else notes.push("lever API ok");
      return { usable, notes, status: res.status, finalUrl: res.finalUrl, error: null };
    }
    if (handler === "ashby") {
      const slug = new URL(url).pathname.split("/").filter(Boolean)[0];
      const api = `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(slug!)}`;
      const res = await fetchText(api);
      const usable = res.status === 200 && /"jobs"\s*:/.test(res.body);
      if (!usable) notes.push(`ashby API ${res.status}`);
      else notes.push("ashby API ok");
      return { usable, notes, status: res.status, finalUrl: res.finalUrl, error: null };
    }
    if (handler === "recruitee") {
      const host = new URL(url).hostname;
      const board = host.replace(/\.recruitee\.com$/i, "");
      const api = `https://${board}.recruitee.com/api/offers/`;
      const res = await fetchText(api);
      const usable = res.status === 200 && /"offers"\s*:/.test(res.body);
      if (!usable) notes.push(`recruitee API ${res.status}`);
      else notes.push("recruitee API ok");
      return { usable, notes, status: res.status, finalUrl: res.finalUrl, error: null };
    }
    if (handler === "smartrecruiters") {
      const slug = new URL(url).pathname.split("/").filter(Boolean)[0];
      const api = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(slug!)}/postings?limit=1&offset=0`;
      const res = await fetchText(api);
      const usable = res.status === 200 && /"content"\s*:/.test(res.body);
      if (!usable) notes.push(`smartrecruiters API ${res.status}`);
      else notes.push("smartrecruiters API ok");
      return { usable, notes, status: res.status, finalUrl: res.finalUrl, error: null };
    }
    if (handler === "workday") {
      const parsed = new URL(url);
      const host = parsed.hostname.toLowerCase();
      const tenant = host.split(".")[0];
      const parts = parsed.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const locale = parts[0] && /^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(parts[0]) ? parts[0] : null;
      const site = locale ? parts[1] : parts[0];
      const api = `https://${host}/wday/cxs/${encodeURIComponent(tenant!)}/${encodeURIComponent(site!)}/jobs`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(api, {
          method: "POST",
          signal: controller.signal,
          headers: { "user-agent": USER_AGENT, accept: "application/json", "content-type": "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: 1, offset: 0, searchText: "" }),
        });
        const body = await response.text();
        const usable = response.status === 200 && /"jobPostings"\s*:/.test(body);
        if (!usable) notes.push(`workday API ${response.status}`);
        else notes.push("workday API ok");
        return { usable, notes, status: response.status, finalUrl: response.url, error: null };
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    return { usable: false, notes: ["ATS probe failed"], status: null, finalUrl: null, error: error instanceof Error ? error.message : String(error) };
  }
  return { usable: false, notes: ["unknown ATS"], status: null, finalUrl: null, error: null };
}

async function probeRow(company: { name: string; url: string; sector: string }): Promise<Row> {
  const handler = classify(company.url);
  const base: Row = {
    name: company.name,
    url: company.url,
    sector: company.sector,
    handler,
    ok: false,
    status: null,
    finalUrl: null,
    error: null,
    usable: false,
    notes: [],
  };
  try {
    new URL(company.url);
  } catch {
    return { ...base, handler: "unhandled", error: "invalid URL", notes: ["invalid URL"] };
  }

  if (handler !== "career-browser" && handler !== "unhandled") {
    const ats = await probeAts(handler, company.url);
    return {
      ...base,
      ok: ats.status != null && ats.status >= 200 && ats.status < 400,
      status: ats.status,
      finalUrl: ats.finalUrl,
      error: ats.error,
      usable: ats.usable,
      notes: ats.notes,
    };
  }

  try {
    const page = await fetchText(company.url);
    const career = careerLooksUsable(page.body, page.finalUrl);
    const ok = page.status >= 200 && page.status < 400;
    return {
      ...base,
      ok,
      status: page.status,
      finalUrl: page.finalUrl,
      usable: ok && career.usable,
      notes: career.notes,
      error: ok ? null : `HTTP ${page.status}`,
    };
  } catch (error) {
    return {
      ...base,
      error: error instanceof Error ? error.message : String(error),
      notes: ["request failed"],
    };
  }
}

async function pool<T>(items: T[], limit: number, work: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      await work(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
}

async function main() {
  const companies = catalog.companies.filter((row) => row.name && row.url);
  const list = LIMIT ? companies.slice(0, LIMIT) : companies;
  const rows: Row[] = new Array(list.length);
  let done = 0;
  const started = Date.now();
  console.log(`Probing ${list.length} companies (concurrency ${CONCURRENCY})…`);

  await pool(list, CONCURRENCY, async (company, index) => {
    rows[index] = await probeRow(company);
    done += 1;
    if (done % 50 === 0 || done === list.length) {
      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      console.log(`  ${done}/${list.length} (${elapsed}s)`);
    }
  });

  const summary = {
    total: rows.length,
    byHandler: {} as Record<string, number>,
    reachable: rows.filter((row) => row.ok).length,
    usable: rows.filter((row) => row.usable).length,
    broken: rows.filter((row) => !row.ok).length,
    unusableCareer: rows.filter((row) => row.handler === "career-browser" && row.ok && !row.usable).length,
    atsBroken: rows.filter((row) => row.handler !== "career-browser" && row.handler !== "unhandled" && !row.usable).length,
  };
  for (const row of rows) summary.byHandler[row.handler] = (summary.byHandler[row.handler] || 0) + 1;

  const outDir = path.join(process.cwd(), "tmp");
  await mkdir(outDir, { recursive: true });
  const jsonPath = path.join(outDir, "job-boards-probe.json");
  const mdPath = path.join(outDir, "job-boards-probe.md");
  await writeFile(jsonPath, JSON.stringify({ summary, rows }, null, 2));

  const broken = rows.filter((row) => !row.ok).slice(0, 200);
  const atsBroken = rows.filter((row) => row.handler !== "career-browser" && row.handler !== "unhandled" && !row.usable);
  const careerDead = rows.filter((row) => row.handler === "career-browser" && row.ok && !row.usable).slice(0, 300);
  const md = [
    "# Job boards catalog probe",
    "",
    `Probed ${summary.total} companies.`,
    "",
    "## Summary",
    "",
    `- Reachable HTTP: **${summary.reachable}**`,
    `- Usable by current Fitboard handlers: **${summary.usable}**`,
    `- Broken / unreachable: **${summary.broken}**`,
    `- ATS configured but API unusable: **${summary.atsBroken}**`,
    `- Career page reachable but no search/job signals: **${summary.unusableCareer}**`,
    "",
    "### By handler",
    "",
    ...Object.entries(summary.byHandler).map(([handler, count]) => `- ${handler}: ${count}`),
    "",
    "## ATS rows the current code cannot use",
    "",
    ...(atsBroken.length === 0 ? ["None."] : atsBroken.map((row) => `- **${row.name}** \`${row.url}\` — ${row.notes.join("; ") || row.error || "unusable"}`)),
    "",
    "## Unreachable URLs (first 200)",
    "",
    ...(broken.length === 0 ? ["None."] : broken.map((row) => `- **${row.name}** \`${row.url}\` — ${row.error || `HTTP ${row.status}`}`)),
    "",
    "## Career pages with no crawl signal (first 300)",
    "",
    ...(careerDead.length === 0
      ? ["None."]
      : careerDead.map((row) => `- **${row.name}** \`${row.url}\` — ${row.notes.join("; ")}`)),
    "",
  ].join("\n");
  await writeFile(mdPath, md);

  console.log(JSON.stringify(summary, null, 2));
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
