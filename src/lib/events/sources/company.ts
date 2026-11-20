import "server-only";

import catalog from "../../../../config/company-events.json";

import { countryCodeFor } from "@/lib/job-search/countries";

import { normalizeEventPlace } from "../place";
import type { FoundEvent } from "../types";
import { getJson, settledInBatches, SourceError } from "./http";

// Company sites: official vendor event hubs (AWS, Google Cloud, MongoDB, …)
// listed in config/company-events.json. Each company has a parser kind.

type CompanyConfig = {
  id: string;
  name: string;
  parser: "aws-cards" | "gdg" | "mongodb" | "json-ld" | "html-events";
  pages: string[];
};

const companies = (catalog as { companies: CompanyConfig[] }).companies;

const CONCURRENCY = 3;

function dayStart(isoDate: string): string | null {
  const day = isoDate.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  return `${day}T00:00:00.000Z`;
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return value
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
      .replace(/\\n/g, "\n")
      .replace(/\\"/g, '"');
  }
}

function fieldNear(chunk: string, name: string): string {
  const match = chunk.match(new RegExp(`"${name}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  return match ? decodeJsonString(match[1]!) : "";
}

function absoluteUrl(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

/** "Dubai World Trade Center" → "Dubai"; "Tel Aviv Expo" → "Tel Aviv". */
function cityFromVenue(place: string): string {
  const head = place.split(",")[0]?.trim() ?? "";
  if (!head) return "";
  const match = head.match(/^(.+?)(?:\s+(?:World|Convention|Expo|Centre|Center|International|Messe|Trade|Gallagher|Arena|Stadium)\b|$)/i);
  return (match?.[1] ?? head).trim();
}

function toFound(
  company: CompanyConfig,
  partial: {
    externalId: string;
    title: string;
    summary?: string;
    url: string;
    location?: string;
    city?: string;
    country?: string;
    remote?: boolean | null;
    format?: FoundEvent["format"];
    startsAt?: string | null;
    endsAt?: string | null;
  },
): FoundEvent | null {
  const title = partial.title.trim();
  const url = partial.url.trim();
  if (!title || !url) return null;
  const online = partial.format === "VIRTUAL" || partial.remote === true;
  const where = normalizeEventPlace({
    location: partial.location ?? "",
    city: partial.city ?? "",
    country: partial.country ?? "",
    online,
  });
  const prefixed = title.toLowerCase().startsWith(company.name.toLowerCase()) ? title : `${company.name}: ${title}`;
  return {
    source: "COMPANY",
    externalId: `${company.id}:${partial.externalId}`.slice(0, 300),
    title: prefixed.slice(0, 300),
    summary: (partial.summary ?? "").slice(0, 20_000),
    url: url.slice(0, 2000),
    place: where.place,
    city: where.city,
    country: where.country,
    remote: partial.remote ?? (online ? true : where.place === "Online" ? true : null),
    format: partial.format ?? (online ? "VIRTUAL" : where.place && where.place !== "Online" ? "IN_PERSON" : "UNKNOWN"),
    startsAt: partial.startsAt ?? null,
    endsAt: partial.endsAt ?? null,
    ticketPrice: "",
    speakers: [],
    attendance: null,
    audience: company.name.slice(0, 200),
  };
}

/** AWS marketing pages embed CMS card JSON: itemTitle, itemMetaDate, itemMetaLocation, itemCTALink. */
export function eventsFromAwsCards(html: string, pageUrl: string, company: CompanyConfig, today: string): FoundEvent[] {
  const events: FoundEvent[] = [];
  const seen = new Set<string>();
  // Prefer whole "fields":{...} objects so neighbouring cards do not bleed dates.
  const fieldBlocks = [...html.matchAll(/"fields"\s*:\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)].map((match) => match[1] ?? "");
  const chunks =
    fieldBlocks.length > 0
      ? fieldBlocks
      : [...html.matchAll(/"itemTitle"\s*:\s*"((?:\\.|[^"\\])*)"/g)].map((match) => {
          const index = match.index ?? 0;
          return html.slice(Math.max(0, index - 200), Math.min(html.length, index + 400));
        });
  for (const chunk of chunks) {
    const title = fieldNear(chunk, "itemTitle");
    if (!title) continue;
    const date = (fieldNear(chunk, "itemMetaDate") || fieldNear(chunk, "startDateTime")).slice(0, 10);
    const place = fieldNear(chunk, "itemMetaLocation") || fieldNear(chunk, "location");
    const href = fieldNear(chunk, "itemCTALink") || fieldNear(chunk, "itemCTAHref") || pageUrl;
    const body = fieldNear(chunk, "itemBody");
    const badge = fieldNear(chunk, "itemBadge");
    const id = fieldNear(chunk, "id") || `${title}:${date}`;
    if (date && date < today) continue;
    if (!date && badge.toLowerCase() === "on demand") continue;
    const key = `${title}|${date}|${href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const remote = /\b(online|virtual|remote)\b/i.test(`${title} ${place} ${body} ${badge}`);
    const event = toFound(company, {
      externalId: id,
      title,
      summary: body,
      url: absoluteUrl(href, pageUrl),
      location: place,
      city: cityFromVenue(place),
      remote,
      format: remote ? "VIRTUAL" : "IN_PERSON",
      startsAt: date ? dayStart(date) : null,
    });
    if (event) events.push(event);
  }
  // re:Invent-style hero copy when no CMS cards.
  if (events.length === 0 && /re:Invent/i.test(html)) {
    const dateMatch = html.match(/Nov\.?\s*(\d{1,2})\s*[–-]\s*(?:Dec\.?\s*)?(\d{1,2}),?\s*(20\d{2})/i);
    const year = dateMatch?.[3] ?? "";
    const startDay = dateMatch ? `${year}-11-${dateMatch[1]!.padStart(2, "0")}` : "";
    if (startDay && startDay >= today) {
      const event = toFound(company, {
        externalId: `reinvent-${year}`,
        title: `AWS re:Invent ${year}`,
        summary: "AWS re:Invent — cloud and AI conference.",
        url: pageUrl,
        location: "Las Vegas, NV",
        city: "Las Vegas",
        country: "us",
        format: "IN_PERSON",
        startsAt: dayStart(startDay),
      });
      if (event) events.push(event);
    }
  }
  return events;
}

type GdgResult = {
  id?: number | string;
  title?: string;
  description_short?: string;
  city?: string;
  start_date?: string;
  url?: string;
  chapter?: { city?: string; country?: string; country_name?: string; chapter_location?: string };
  tags?: string[];
};

/** Google Developer Groups / Cloud community events (official Google community platform). */
export function eventsFromGdg(payload: unknown, company: CompanyConfig, today: string): FoundEvent[] {
  const rows = (payload as { results?: unknown[] })?.results;
  if (!Array.isArray(rows)) throw new SourceError("changed its format");
  const events: FoundEvent[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const item = row as GdgResult;
    const title = (item.title ?? "").trim();
    const url = (item.url ?? "").trim();
    const start = (item.start_date ?? "").trim();
    if (!title || !url || !start) continue;
    const day = start.slice(0, 10);
    if (day < today) continue;
    const id = String(item.id ?? `${title}:${day}`);
    if (seen.has(id)) continue;
    seen.add(id);
    const city = item.city || item.chapter?.city || "";
    const country = (item.chapter?.country ?? "").toLowerCase() || countryCodeFor(item.chapter?.country_name ?? "");
    const location = item.chapter?.chapter_location || [city, item.chapter?.country_name].filter(Boolean).join(", ");
    const tags = (item.tags ?? []).join(" ");
    const remote = /\b(online|virtual|onair|on-air)\b/i.test(`${title} ${tags} ${location}`);
    const event = toFound(company, {
      externalId: id,
      title,
      summary: [item.description_short ?? "", tags ? `Topics: ${tags}` : ""].filter(Boolean).join("\n\n"),
      url,
      location,
      city,
      country,
      remote,
      format: remote ? "VIRTUAL" : "IN_PERSON",
      startsAt: Number.isFinite(Date.parse(start)) ? new Date(start).toISOString() : dayStart(day),
    });
    if (event) events.push(event);
  }
  return events;
}

/** JSON-LD Event / ItemList of Events. */
export function eventsFromJsonLd(html: string, pageUrl: string, company: CompanyConfig, today: string): FoundEvent[] {
  const events: FoundEvent[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data: unknown;
    try {
      data = JSON.parse(match[1]!);
    } catch {
      continue;
    }
    const nodes = Array.isArray(data) ? data : [data];
    for (const node of nodes) {
      const queue = [node];
      while (queue.length > 0) {
        const current = queue.shift() as Record<string, unknown> | undefined;
        if (!current || typeof current !== "object") continue;
        const type = current["@type"];
        const types = Array.isArray(type) ? type.map(String) : type ? [String(type)] : [];
        if (types.some((entry) => /Event$/i.test(entry))) {
          const title = String(current.name ?? current.headline ?? "").trim();
          const url = String(current.url ?? current["@id"] ?? pageUrl).trim();
          const start = String(current.startDate ?? "").trim();
          const end = String(current.endDate ?? "").trim();
          const day = start.slice(0, 10);
          if (!title || (day && day < today)) continue;
          const location = current.location;
          let place = "";
          let city = "";
          let country = "";
          if (typeof location === "string") place = location;
          else if (location && typeof location === "object") {
            const loc = location as Record<string, unknown>;
            place = String(loc.name ?? "");
            const address = loc.address as Record<string, unknown> | string | undefined;
            if (typeof address === "string") place = place || address;
            else if (address && typeof address === "object") {
              city = String(address.addressLocality ?? "");
              country = countryCodeFor(String(address.addressCountry ?? "")) || String(address.addressCountry ?? "").toLowerCase();
              place = [city, address.addressRegion, address.addressCountry].filter(Boolean).join(", ") || place;
            }
          }
          const key = `${title}|${day}|${url}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const remote = current.eventAttendanceMode?.toString().toLowerCase().includes("online") || /\bonline\b/i.test(place);
          const event = toFound(company, {
            externalId: key.slice(0, 200),
            title,
            summary: String(current.description ?? "").slice(0, 2000),
            url: absoluteUrl(url, pageUrl),
            location: place,
            city,
            country,
            remote,
            format: remote ? "VIRTUAL" : "IN_PERSON",
            startsAt: start ? (Number.isFinite(Date.parse(start)) ? new Date(start).toISOString() : dayStart(day)) : null,
            endsAt: end ? (Number.isFinite(Date.parse(end)) ? new Date(end).toISOString() : dayStart(end.slice(0, 10))) : null,
          });
          if (event) events.push(event);
        }
        if (Array.isArray(current.itemListElement)) queue.push(...current.itemListElement);
        if (current.item && typeof current.item === "object") queue.push(current.item);
        if (Array.isArray(current["@graph"])) queue.push(...current["@graph"]);
      }
    }
  }
  return events;
}

/** Heuristic HTML: dated headings + nearby links (Microsoft, Datadog, HashiCorp, …). */
export function eventsFromHtmlHeuristics(html: string, pageUrl: string, company: CompanyConfig, today: string): FoundEvent[] {
  const events: FoundEvent[] = [];
  const seen = new Set<string>();
  // ISO dates next to titles in text blocks.
  for (const match of html.matchAll(
    /(?:<h[1-3][^>]*>|<a[^>]*href="([^"]+)"[^>]*>)\s*([^<]{8,120}?)\s*<\/(?:h[1-3]|a)>[\s\S]{0,280}?(20\d{2}-\d{2}-\d{2}|\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+20\d{2})/gi,
  )) {
    const href = match[1] || pageUrl;
    const title = match[2]!.replace(/\s+/g, " ").trim();
    const rawDate = match[3]!;
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : (() => {
          const parsed = Date.parse(rawDate);
          return Number.isFinite(parsed) ? new Date(parsed).toISOString().slice(0, 10) : "";
        })();
    if (!title || !iso || iso < today) continue;
    if (/cookie|privacy|sign in|subscribe/i.test(title)) continue;
    const key = `${title}|${iso}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const remote = /\b(online|virtual|webinar)\b/i.test(title);
    const event = toFound(company, {
      externalId: key.slice(0, 200),
      title,
      url: absoluteUrl(href, pageUrl),
      remote,
      format: remote ? "VIRTUAL" : "UNKNOWN",
      startsAt: dayStart(iso),
    });
    if (event) events.push(event);
  }
  return events.slice(0, 40);
}

/** MongoDB events hub + .local city pages. */
export function eventsFromMongodb(html: string, pageUrl: string, company: CompanyConfig, today: string): FoundEvent[] {
  const fromLd = eventsFromJsonLd(html, pageUrl, company, today);
  const fromAws = eventsFromAwsCards(html, pageUrl, company, today);
  const events = [...fromLd, ...fromAws];
  const seen = new Set(events.map((event) => event.externalId));

  // "November 19, 2026" + city near MongoDB.local
  const localCity = pageUrl.match(/mongodb-local\/([a-z0-9-]+)/i)?.[1];
  if (localCity) {
    const dateMatch = html.match(/\b((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+20\d{2})\b/i);
    const iso = dateMatch ? new Date(dateMatch[1]!).toISOString().slice(0, 10) : "";
    if (iso && iso >= today) {
      const cityName = localCity
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
      const id = `local-${localCity}-${iso}`;
      if (!seen.has(`${company.id}:${id}`)) {
        const event = toFound(company, {
          externalId: id,
          title: `MongoDB.local ${cityName}`,
          summary: "MongoDB.local — in-person day with MongoDB experts.",
          url: pageUrl,
          city: cityName,
          location: cityName,
          format: "IN_PERSON",
          startsAt: dayStart(iso),
        });
        if (event) events.push(event);
      }
    }
  }

  // Discover more .local city links for follow-up pages (handled by config pages + same HTML).
  return events;
}

/** Company marketing pages; keep the budget below the shared events HTTP cap. */
const COMPANY_MAX_BYTES = 1_500_000;
const COMPANY_TIMEOUT_MS = 12_000;

async function getCompanyText(url: string, signal?: AbortSignal): Promise<string> {
  const timeout = AbortSignal.timeout(COMPANY_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        accept: "application/json, text/html;q=0.9, */*;q=0.5",
        "user-agent": "Fitboard/1.0 (events search)",
      },
      redirect: "follow",
      cache: "no-store",
      signal: combined,
    });
  } catch {
    if (signal?.aborted) throw new SourceError("was stopped");
    throw new SourceError(timeout.aborted ? "took too long to answer" : "couldn't be reached");
  }
  if (!response.ok) throw new SourceError(`answered with an error (${response.status})`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > COMPANY_MAX_BYTES) throw new SourceError("sent too much");
  const reader = response.body?.getReader();
  if (!reader) throw new SourceError("couldn't be read");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > COMPANY_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        throw new SourceError("sent too much");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof SourceError) throw error;
    if (signal?.aborted) throw new SourceError("was stopped");
    throw new SourceError(timeout.aborted ? "took too long to answer" : "couldn't be read");
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

async function fetchCompanyPage(company: CompanyConfig, page: string, today: string, signal?: AbortSignal): Promise<FoundEvent[]> {
  if (company.parser === "gdg" || page.includes("gdg.community.dev/api/")) {
    const payload = await getJson(page, { signal });
    return eventsFromGdg(payload, company, today);
  }
  const html = await getCompanyText(page, signal);
  if (company.parser === "aws-cards") return eventsFromAwsCards(html, page, company, today);
  if (company.parser === "mongodb") return eventsFromMongodb(html, page, company, today);
  if (company.parser === "json-ld") {
    const fromLd = eventsFromJsonLd(html, page, company, today);
    return fromLd.length > 0 ? fromLd : eventsFromHtmlHeuristics(html, page, company, today);
  }
  const mixed = [...eventsFromJsonLd(html, page, company, today), ...eventsFromAwsCards(html, page, company, today), ...eventsFromHtmlHeuristics(html, page, company, today)];
  const seen = new Set<string>();
  return mixed.filter((event) => {
    if (seen.has(event.externalId)) return false;
    seen.add(event.externalId);
    return true;
  });
}

/** Official company event sites from config/company-events.json. */
export async function fetchCompanyEvents(signal?: AbortSignal, now = new Date()): Promise<FoundEvent[]> {
  if (companies.length === 0) throw new SourceError("company events config is empty");
  const today = now.toISOString().slice(0, 10);
  const tasks = companies.flatMap((company) => company.pages.map((page) => ({ company, page })));
  const results = await settledInBatches(tasks, CONCURRENCY, (task) => fetchCompanyPage(task.company, task.page, today, signal));

  const events: FoundEvent[] = [];
  const seen = new Set<string>();
  let anyOk = false;
  let lastError: unknown;
  for (const result of results) {
    if (result.status !== "fulfilled") {
      lastError = result.reason;
      continue;
    }
    anyOk = true;
    for (const event of result.value) {
      if (seen.has(event.externalId)) continue;
      seen.add(event.externalId);
      events.push(event);
    }
  }
  if (!anyOk) {
    if (lastError instanceof SourceError) throw lastError;
    throw new SourceError("did not answer");
  }
  return events;
}
