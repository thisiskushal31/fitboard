import "server-only";

import { prisma } from "@/lib/core/prisma";
import { env } from "@/lib/core/env";
import { logServerError } from "@/lib/core/log";

import {
  attributionForSources,
  enabledLayoffSources,
  labelForLayoffSourceUrl,
  layoffSourceById,
  type LayoffSourceConfig,
} from "./layoff-sources";

type LayoffRow = {
  company: string;
  normalizedCompany: string;
  laidOff: number | null;
  percentage: number | null;
  date: Date | null;
  location: string;
  country: string;
  industry: string;
  sourceUrl: string;
  rawNote: string;
};

export type LayoffSyncResult = {
  imported: number;
  companies: number;
  /** Primary attribution URL from the first successful source. */
  url: string;
  /** Source ids from config/layoff-sources.json that contributed rows. */
  sources: string[];
};

export type LayoffEventView = {
  company: string;
  laidOff: number | null;
  percentage: number | null;
  date: string | null;
  location: string;
  country: string;
  industry: string;
  note: string;
  source: string;
  sourceUrl: string;
  roleMention: boolean;
};

export type CompanyLayoffsView = {
  company: string;
  events: LayoffEventView[];
  totalLaidOff: number | null;
  latestDate: string | null;
  attribution: string;
  attributionUrl: string;
  /** Source labels that appear on the matched events (or catalog defaults). */
  sources: string[];
  summary: string;
};

const CORP_SUFFIX =
  /\b(inc|incorporated|ltd|limited|llc|llp|plc|corp|corporation|co|company|holdings?|group|technologies|technology|tech|ag|sa|bv|gmbh|kabushiki|kaisha|kk|pty|pvt|private|public)\b/gi;

const UA = "Fitboard/1.0 (layoff sync)";

/** Normalize a company name for matching (no company-specific aliases). */
export function normalizeCompanyName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(CORP_SUFFIX, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function parseDate(raw: string): Date | null {
  const text = raw.trim();
  if (!text || /^null$/i.test(text)) return null;
  const mdy = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdy) {
    const date = new Date(Date.UTC(Number(mdy[3]), Number(mdy[1]) - 1, Number(mdy[2])));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const ymd = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const date = new Date(Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3])));
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const iso = Date.parse(text);
  if (!Number.isNaN(iso)) return new Date(iso);
  return null;
}

function parseNumber(raw: string): number | null {
  const text = raw.trim();
  if (!text || /^null$/i.test(text)) return null;
  const value = Number(text.replace(/%/g, ""));
  return Number.isFinite(value) ? value : null;
}

function roleMentioned(note: string, title: string): boolean {
  const role = title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 3 && !/^(senior|junior|staff|principal|lead|engineer|engineering|manager|director|remote)$/.test(token));
  if (role.length === 0 || !note.trim()) return false;
  const blob = note.toLowerCase();
  return role.some((token) => blob.includes(token));
}

function dateLabel(date: Date | null): string | null {
  if (!date) return null;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function summarize(company: string, events: LayoffEventView[]): string {
  if (events.length === 0) return "No layoff records found for this company.";
  const latest = events[0];
  const withCounts = events.filter((event) => event.laidOff != null);
  const total = withCounts.reduce((sum, event) => sum + (event.laidOff ?? 0), 0);
  const latestBit =
    latest.laidOff != null && latest.date
      ? `${latest.laidOff.toLocaleString("en-US")} people on ${latest.date}`
      : latest.date
        ? `reported on ${latest.date}`
        : latest.laidOff != null
          ? `${latest.laidOff.toLocaleString("en-US")} people`
          : "reported (headcount unknown)";
  const more = events.length > 1 ? ` · ${events.length} events on record` : "";
  const totalBit = withCounts.length > 1 && total > 0 ? ` · ${total.toLocaleString("en-US")} total counted` : "";
  const roleBit = events.some((event) => event.roleMention) ? " · notes mention this kind of role/team" : "";
  return `${company}: ${latestBit}${more}${totalBit}${roleBit}.`;
}

/** First occurrence wins — feed preferred sources first. */
export function dedupeLayoffRows(rows: LayoffRow[]): LayoffRow[] {
  const seen = new Map<string, LayoffRow>();
  for (const row of rows) {
    const key = `${row.normalizedCompany}|${dateLabel(row.date) ?? ""}|${row.laidOff ?? "x"}`;
    if (!seen.has(key)) seen.set(key, row);
  }
  return [...seen.values()];
}

async function replaceLayoffRows(rows: LayoffRow[]): Promise<{ imported: number; companies: number }> {
  const sorted = [...rows].sort((a, b) => {
    const aTime = a.date?.getTime() ?? 0;
    const bTime = b.date?.getTime() ?? 0;
    return bTime - aTime || (b.laidOff ?? 0) - (a.laidOff ?? 0) || a.company.localeCompare(b.company);
  });

  await prisma.$transaction(
    async (tx) => {
      await tx.companyLayoff.deleteMany();
      const chunk = 500;
      for (let i = 0; i < sorted.length; i += chunk) {
        await tx.companyLayoff.createMany({ data: sorted.slice(i, i + chunk) });
      }
    },
    { timeout: 120_000, maxWait: 20_000 },
  );

  const companies = new Set(sorted.map((row) => row.normalizedCompany)).size;
  return { imported: sorted.length, companies };
}

function choiceName(choices: Record<string, { name?: string }> | undefined, id: unknown): string {
  if (typeof id !== "string" || !choices) return "";
  return choices[id]?.name?.trim() ?? "";
}

function choiceNames(choices: Record<string, { name?: string }> | undefined, ids: unknown): string {
  if (!Array.isArray(ids)) return choiceName(choices, ids);
  return ids
    .map((id) => choiceName(choices, id))
    .filter(Boolean)
    .join(", ");
}

function trackerUrl(source: LayoffSourceConfig, fallback = ""): string {
  return (source.attributionUrl || source.url || fallback).slice(0, 2000);
}

/**
 * Parse layoff rows from a Layoffs.fyi-style CSV.
 * Expected columns: company, location, industry, total_laid_off, percentage_laid_off, date, …
 */
export function parseLayoffsCsv(csv: string, sourceUrl = "https://layoffs.fyi/"): LayoffRow[] {
  const lines = csv.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];

  const header = parseCsvLine(lines[0]).map((cell) => cell.toLowerCase().replace(/\s+/g, "_"));
  const indexOf = (...names: string[]) => header.findIndex((cell) => names.includes(cell));
  const companyIdx = indexOf("company");
  const locationIdx = indexOf("location", "location_hq");
  const industryIdx = indexOf("industry");
  const laidOffIdx = indexOf("total_laid_off", "laid_off", "employees", "#_laid_off");
  const percentageIdx = indexOf("percentage_laid_off", "percentage", "percent", "%");
  const dateIdx = indexOf("date");
  const countryIdx = indexOf("country");
  const sourceIdx = indexOf("source");
  if (companyIdx < 0 || dateIdx < 0) throw new Error("Layoff CSV is missing company or date columns.");

  const rows: LayoffRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const company = (cells[companyIdx] ?? "").trim();
    if (!company) continue;
    const date = parseDate(cells[dateIdx] ?? "");
    const laidOff = laidOffIdx >= 0 ? parseNumber(cells[laidOffIdx] ?? "") : null;
    const percentageRaw = percentageIdx >= 0 ? parseNumber(cells[percentageIdx] ?? "") : null;
    const percentage = percentageRaw == null ? null : percentageRaw > 1 ? percentageRaw / 100 : percentageRaw;
    const article = sourceIdx >= 0 ? (cells[sourceIdx] ?? "").trim() : "";
    rows.push({
      company: company.slice(0, 300),
      normalizedCompany: normalizeCompanyName(company).slice(0, 300),
      laidOff,
      percentage,
      date,
      location: (locationIdx >= 0 ? cells[locationIdx] ?? "" : "").slice(0, 300),
      country: (countryIdx >= 0 ? cells[countryIdx] ?? "" : "").replace(/\.$/, "").slice(0, 120),
      industry: (industryIdx >= 0 ? cells[industryIdx] ?? "" : "").slice(0, 120),
      sourceUrl: sourceUrl.slice(0, 2000),
      rawNote: (article.startsWith("http") ? article : "").slice(0, 500),
    });
  }
  return rows;
}

export async function syncLayoffsFromCsv(csv: string): Promise<{ imported: number; companies: number }> {
  const stamp = layoffSourceById("layoffs.csv")?.urls?.[0] || "https://layoffs.fyi/";
  return replaceLayoffRows(parseLayoffsCsv(csv, stamp));
}

export async function resolveLayoffsAirtableDataUrl(embedUrl: string): Promise<string> {
  const response = await fetch(embedUrl, {
    headers: { accept: "text/html", "user-agent": UA },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Layoffs Airtable embed responded with HTTP ${response.status}.`);
  const html = await response.text();
  const match = html.match(/urlWithParams:\s*"([^"]+)"/);
  if (!match?.[1]) throw new Error("Could not find Airtable data URL in the layoff embed page.");
  return `https://airtable.com${match[1].replaceAll("\\u002F", "/")}`;
}

export async function fetchLayoffsFyiAirtableRows(source = layoffSourceById("layoffs.fyi")): Promise<LayoffRow[]> {
  if (!source?.embedUrl || !source.appId) throw new Error("Airtable layoff source is missing embedUrl or appId in config.");
  const dataUrl = await resolveLayoffsAirtableDataUrl(source.embedUrl);
  const response = await fetch(dataUrl, {
    headers: {
      accept: "application/json",
      "x-airtable-application-id": source.appId,
      "x-airtable-inter-service-client": "webClient",
      "x-requested-with": "XMLHttpRequest",
      "x-time-zone": "America/Los_Angeles",
      "user-agent": UA,
    },
    signal: AbortSignal.timeout(90_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Layoffs Airtable data responded with HTTP ${response.status}.`);
  const payload = (await response.json()) as {
    data?: {
      table?: {
        columns?: { id: string; name: string; typeOptions?: { choices?: Record<string, { name?: string }> } }[];
        rows?: { cellValuesByColumnId?: Record<string, unknown> }[];
      };
    };
  };
  const table = payload.data?.table;
  if (!table?.columns?.length || !table.rows?.length) throw new Error("Layoffs Airtable returned no rows.");

  const byName = Object.fromEntries(table.columns.map((column) => [column.name, column]));
  const idOf = (name: string) => byName[name]?.id;
  const companyId = idOf("Company");
  const dateId = idOf("Date");
  const laidOffId = idOf("# Laid Off");
  const percentageId = idOf("%");
  const locationId = idOf("Location HQ");
  const industryId = idOf("Industry");
  const countryId = idOf("Country");
  const sourceId = idOf("Source");
  if (!companyId || !dateId) throw new Error("Layoffs Airtable is missing Company or Date columns.");

  const attribution = trackerUrl(source);
  const rows: LayoffRow[] = [];
  for (const row of table.rows) {
    const cells = row.cellValuesByColumnId ?? {};
    const company = String(cells[companyId] ?? "").trim();
    if (!company) continue;
    const dateRaw = cells[dateId];
    const date = typeof dateRaw === "string" ? parseDate(dateRaw.slice(0, 10)) : null;
    const laidOff = typeof cells[laidOffId ?? ""] === "number" ? (cells[laidOffId!] as number) : parseNumber(String(cells[laidOffId ?? ""] ?? ""));
    const percentageRaw = typeof cells[percentageId ?? ""] === "number" ? (cells[percentageId!] as number) : parseNumber(String(cells[percentageId ?? ""] ?? ""));
    const percentage = percentageRaw == null ? null : percentageRaw > 1 ? percentageRaw / 100 : percentageRaw;
    const article = String(cells[sourceId ?? ""] ?? "").trim();
    rows.push({
      company: company.slice(0, 300),
      normalizedCompany: normalizeCompanyName(company).slice(0, 300),
      laidOff,
      percentage,
      date,
      location: choiceNames(byName["Location HQ"]?.typeOptions?.choices, cells[locationId ?? ""]).slice(0, 300),
      country: choiceName(byName.Country?.typeOptions?.choices, cells[countryId ?? ""]).slice(0, 120),
      industry: choiceName(byName.Industry?.typeOptions?.choices, cells[industryId ?? ""]).slice(0, 120),
      sourceUrl: attribution,
      rawNote: (article.startsWith("http") ? article : "").slice(0, 500),
    });
  }
  return rows;
}

async function fetchCsvFromUrls(urls: string[]): Promise<{ rows: LayoffRow[]; url: string }> {
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        headers: { accept: "text/csv,text/plain,*/*", "user-agent": UA },
        signal: AbortSignal.timeout(60_000),
        cache: "no-store",
      });
      if (!response.ok) {
        errors.push(`${url} → HTTP ${response.status}`);
        continue;
      }
      // Stamp the mirror URL so UI attribution can tell CSV apart from live Airtable.
      const rows = parseLayoffsCsv(await response.text(), url);
      if (rows.length === 0) {
        errors.push(`${url} → empty CSV`);
        continue;
      }
      return { rows, url };
    } catch (error) {
      errors.push(`${url} → ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`All layoff CSV mirrors failed (${errors.slice(0, 3).join("; ")}).`);
}

export async function fetchWarnLatestRows(source = layoffSourceById("warn")): Promise<LayoffRow[]> {
  if (!source?.urls?.length) throw new Error("WARN layoff source has no urls in config.");
  const errors: string[] = [];
  const attribution = trackerUrl(source);
  for (const url of source.urls) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": UA },
        signal: AbortSignal.timeout(45_000),
        cache: "no-store",
      });
      if (!response.ok) {
        errors.push(`HTTP ${response.status}`);
        continue;
      }
      const payload = (await response.json()) as {
        notices?: {
          company?: string;
          company_canonical?: string;
          location?: string;
          state?: string;
          employees_affected?: number | null;
          notice_date?: string;
          effective_date?: string;
          notice_type?: string;
        }[];
      };
      const notices = Array.isArray(payload.notices) ? payload.notices : [];
      if (notices.length === 0) {
        errors.push("empty notices");
        continue;
      }
      const rows: LayoffRow[] = [];
      for (const notice of notices) {
        const company = String(notice.company_canonical || notice.company || "").trim();
        if (!company) continue;
        rows.push({
          company: company.slice(0, 300),
          normalizedCompany: normalizeCompanyName(company).slice(0, 300),
          laidOff: typeof notice.employees_affected === "number" && Number.isFinite(notice.employees_affected) ? notice.employees_affected : null,
          percentage: null,
          date: parseDate(String(notice.notice_date || notice.effective_date || "")),
          location: [notice.location, notice.state].filter(Boolean).join(", ").slice(0, 300),
          country: "United States",
          industry: "",
          sourceUrl: attribution,
          rawNote: String(notice.notice_type || "WARN notice").slice(0, 500),
        });
      }
      if (rows.length === 0) {
        errors.push("no usable notices");
        continue;
      }
      return rows;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`WARN notices feed failed (${errors.join("; ")}).`);
}

export async function fetchLayoffMapRows(source = layoffSourceById("layoffmap")): Promise<LayoffRow[]> {
  const pageUrl = source?.url;
  if (!pageUrl) throw new Error("Layoff Map source is missing url in config.");
  const response = await fetch(pageUrl, {
    headers: { accept: "text/html", "user-agent": UA },
    signal: AbortSignal.timeout(30_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Layoff Map responded with HTTP ${response.status}.`);
  const html = await response.text();
  const marker = '\\"recent\\":[';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error("Could not find Layoff Map recent events payload.");
  const from = start + '\\"recent\\":'.length;
  let depth = 0;
  let end = from;
  for (; end < html.length; end++) {
    const char = html[end];
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        end += 1;
        break;
      }
    }
  }
  const raw = html
    .slice(from, end)
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\");
  const recent = JSON.parse(raw) as {
    date?: string;
    headcountAffected?: number | null;
    percentOfWorkforce?: number | null;
    country?: string;
    reason?: string;
    company?: { name?: string; industry?: string };
  }[];
  if (!Array.isArray(recent) || recent.length === 0) throw new Error("Layoff Map returned no recent events.");

  const attribution = trackerUrl(source);
  const rows: LayoffRow[] = [];
  for (const event of recent) {
    const company = String(event.company?.name || "").trim();
    if (!company) continue;
    const percentageRaw = typeof event.percentOfWorkforce === "number" ? event.percentOfWorkforce : null;
    const percentage = percentageRaw == null ? null : percentageRaw > 1 ? percentageRaw / 100 : percentageRaw;
    rows.push({
      company: company.slice(0, 300),
      normalizedCompany: normalizeCompanyName(company).slice(0, 300),
      laidOff: typeof event.headcountAffected === "number" ? event.headcountAffected : null,
      percentage,
      date: parseDate(String(event.date || "")),
      location: "",
      country: String(event.country || "").slice(0, 120),
      industry: String(event.company?.industry || "").slice(0, 120),
      sourceUrl: attribution,
      rawNote: String(event.reason || "").slice(0, 500),
    });
  }
  if (rows.length === 0) throw new Error("Layoff Map recent events had no usable company rows.");
  return rows;
}

/**
 * Sync every enabled source in config/layoff-sources.json.
 * CSV entries with fallbackFor only run when that source failed.
 * Failures are skipped; sync fails only when nothing produces rows.
 */
export async function syncLayoffsFromUrl(extraCsvUrl = env.FITBOARD_LAYOFFS_URL): Promise<LayoffSyncResult> {
  const batches: LayoffRow[] = [];
  const sources: string[] = [];
  const failed = new Set<string>();
  let primaryUrl = enabledLayoffSources()[0]?.attributionUrl || "https://layoffs.fyi/";

  if (extraCsvUrl) {
    try {
      const csv = await fetchCsvFromUrls([extraCsvUrl]);
      batches.push(...csv.rows);
      if (!sources.includes("layoffs.csv")) sources.push("layoffs.csv");
      primaryUrl = csv.url;
    } catch (error) {
      logServerError("syncLayoffsCsvEnv", error);
    }
  }

  for (const source of enabledLayoffSources()) {
    if (source.fallbackFor && !failed.has(source.fallbackFor)) continue;
    if (sources.includes(source.id) && source.kind === "csv") continue;

    try {
      if (source.kind === "airtable") {
        batches.push(...(await fetchLayoffsFyiAirtableRows(source)));
      } else if (source.kind === "csv") {
        const urls = [...(source.urls ?? [])];
        if (urls.length === 0) throw new Error(`${source.id} has no urls.`);
        const csv = await fetchCsvFromUrls(urls);
        batches.push(...csv.rows);
        if (primaryUrl === enabledLayoffSources()[0]?.attributionUrl) primaryUrl = csv.url;
      } else if (source.kind === "warn-latest") {
        batches.push(...(await fetchWarnLatestRows(source)));
      } else if (source.kind === "layoffmap-html") {
        batches.push(...(await fetchLayoffMapRows(source)));
      } else {
        continue;
      }
      sources.push(source.id);
      if (sources.length === 1 || source.kind === "airtable") primaryUrl = trackerUrl(source);
    } catch (error) {
      failed.add(source.id);
      logServerError(`syncLayoffs:${source.id}`, error);
    }
  }

  const merged = dedupeLayoffRows(batches);
  if (merged.length === 0) {
    throw new Error("No layoff sources responded with usable data. Try again later.");
  }

  const result = await replaceLayoffRows(merged);
  return { ...result, url: primaryUrl, sources };
}

/**
 * Layoffs for a posting's company. Matches normalized names; soft-matches when
 * one normalized name contains the other (dynamic — no company alias table).
 */
export async function layoffsForCompany(company: string, roleTitle = ""): Promise<CompanyLayoffsView> {
  const defaults = attributionForSources([]);
  const name = company.trim();
  if (!name) {
    return {
      company: "",
      events: [],
      totalLaidOff: null,
      latestDate: null,
      attribution: defaults.attribution,
      attributionUrl: defaults.attributionUrl,
      sources: [],
      summary: "No company name on this posting.",
    };
  }

  try {
    const normalized = normalizeCompanyName(name);
    if (!normalized) {
      return {
        company: name,
        events: [],
        totalLaidOff: null,
        latestDate: null,
        attribution: defaults.attribution,
        attributionUrl: defaults.attributionUrl,
        sources: [],
        summary: "No layoff records found for this company.",
      };
    }

    if (!prisma.companyLayoff) {
      throw new Error("CompanyLayoff model is missing from the Prisma client. Run `yarn prisma generate` and restart the app.");
    }

    const exact = await prisma.companyLayoff.findMany({
      where: { normalizedCompany: normalized },
      orderBy: [{ date: "desc" }, { laidOff: "desc" }],
      take: 20,
    });

    let rows = exact;
    if (rows.length === 0) {
      const candidates = await prisma.companyLayoff.findMany({
        where: {
          OR: [{ normalizedCompany: { contains: normalized } }, ...(normalized.length >= 4 ? [{ company: { contains: name.slice(0, 40), mode: "insensitive" as const } }] : [])],
        },
        orderBy: [{ date: "desc" }, { laidOff: "desc" }],
        take: 40,
      });
      rows = candidates
        .filter((row) => {
          const other = row.normalizedCompany;
          return other === normalized || other.includes(normalized) || normalized.includes(other);
        })
        .slice(0, 20);
    }

    const events: LayoffEventView[] = rows.map((row) => ({
      company: row.company,
      laidOff: row.laidOff,
      percentage: row.percentage,
      date: dateLabel(row.date),
      location: row.location,
      country: row.country,
      industry: row.industry,
      note: row.rawNote,
      source: labelForLayoffSourceUrl(row.sourceUrl),
      sourceUrl: row.sourceUrl,
      roleMention: roleMentioned(row.rawNote, roleTitle),
    }));

    const sourceLabels = [...new Set(events.map((event) => event.source).filter(Boolean))];
    const knownIds = sourceLabels
      .map((label) => enabledLayoffSources().find((source) => source.label === label)?.id)
      .filter((id): id is string => Boolean(id));
    const { attribution, attributionUrl } = attributionForSources(knownIds);

    const withCounts = events.filter((event) => event.laidOff != null);
    const totalLaidOff = withCounts.length > 0 ? withCounts.reduce((sum, event) => sum + (event.laidOff ?? 0), 0) : null;
    const primary = knownIds[0] ? layoffSourceById(knownIds[0]) : undefined;
    return {
      company: name,
      events,
      totalLaidOff,
      latestDate: events[0]?.date ?? null,
      attribution: sourceLabels.length > 0 ? `Data from ${sourceLabels.join(", ")}` : attribution,
      attributionUrl: primary?.attributionUrl || attributionUrl,
      sources: sourceLabels,
      summary: summarize(name, events),
    };
  } catch (error) {
    logServerError("layoffsForCompany", error);
    return {
      company: name,
      events: [],
      totalLaidOff: null,
      latestDate: null,
      attribution: defaults.attribution,
      attributionUrl: defaults.attributionUrl,
      sources: [],
      summary: "Layoff lookup failed. Try refreshing layoff data later.",
    };
  }
}

export async function countLayoffRows(): Promise<number> {
  return prisma.companyLayoff.count();
}
