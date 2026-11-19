import "server-only";

import { z } from "zod";

import { countryCodeFor, countryName } from "@/lib/job-search/countries";

import { getJson, settledInBatches, SourceError } from "./http";
import type { FoundEvent } from "../types";

// confs.tech: public conference-data JSON (GitHub via jsDelivr).

/** Topic/year JSON files fetched at once. */
const CONCURRENCY = 6;

const TOPICS = [
  "javascript",
  "typescript",
  "python",
  "java",
  "android",
  "ios",
  "devops",
  "data",
  "ux",
  "product",
  "security",
  "rust",
  "kotlin",
  "general",
  "api",
  "css",
] as const;

const conferenceSchema = z.object({
  name: z.string(),
  url: z.string().optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  city: z.string().optional(),
  country: z.string().optional(),
  online: z.boolean().optional(),
  cfpUrl: z.string().optional(),
  cfpEndDate: z.string().optional(),
  cocUrl: z.string().optional(),
});

const listSchema = z.array(z.unknown());

const yearTopics = (year: number, topic: string) =>
  `https://cdn.jsdelivr.net/gh/tech-conferences/conference-data@main/conferences/${year}/${topic}.json`;

function dayStart(isoDate: string | undefined): string | null {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  return `${isoDate}T00:00:00.000Z`;
}

function placeLine(city: string, countryLabel: string): string {
  const code = countryCodeFor(countryLabel);
  const name = code ? countryName(code) : countryLabel;
  return [city, name].filter(Boolean).join(", ");
}

function toEvent(raw: unknown, topic: string, today: string): FoundEvent | null {
  const parsed = conferenceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  const start = item.startDate?.trim() ?? "";
  if (!start || start < today) return null;
  const title = item.name.trim();
  const url = (item.url ?? "").trim();
  if (!title || !url) return null;
  const city = (item.city ?? "").trim();
  const countryLabel = (item.country ?? "").trim();
  const online = Boolean(item.online) || /^online$/i.test(city) || /^online$/i.test(countryLabel);
  const country = countryCodeFor(countryLabel) || (/^online$/i.test(countryLabel) ? "" : countryLabel.toLowerCase().slice(0, 8));
  const summaryParts = [
    `Topic: ${topic}`,
    item.cfpUrl && item.cfpEndDate ? `CFP open until ${item.cfpEndDate}` : item.cfpUrl ? "CFP listed" : "",
  ].filter(Boolean);
  return {
    source: "CONFSTECH",
    externalId: `${topic}:${title}:${start}`.slice(0, 300),
    title: title.slice(0, 300),
    summary: summaryParts.join(" · ").slice(0, 2000),
    url: url.slice(0, 2000),
    place: online ? "Online" : placeLine(city, countryLabel).slice(0, 300),
    city: online ? "" : city.slice(0, 120),
    country: online ? "" : country.slice(0, 8),
    remote: online ? true : false,
    format: online ? "VIRTUAL" : "IN_PERSON",
    startsAt: dayStart(start),
    endsAt: dayStart(item.endDate),
    ticketPrice: "",
    speakers: [],
    attendance: null,
    audience: "",
  };
}

/** confs.tech conference-data: upcoming conferences by topic for this year and next. */
export async function fetchConfsTechEvents(signal?: AbortSignal, now = new Date()): Promise<FoundEvent[]> {
  const year = now.getUTCFullYear();
  const years = [year, year + 1];
  const urls = years.flatMap((y) => TOPICS.map((topic) => ({ year: y, topic, url: yearTopics(y, topic) })));
  const results = await settledInBatches(urls, CONCURRENCY, (entry) => getJson(entry.url, { signal }));
  const events: FoundEvent[] = [];
  const seen = new Set<string>();
  let anyOk = false;
  let lastError: unknown;
  const today = now.toISOString().slice(0, 10);

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const { topic } = urls[index];
    if (result.status !== "fulfilled") {
      lastError = result.reason;
      // Missing topic file (404): empty list for that topic/year.
      if (result.reason instanceof SourceError && /answered with an error \(404\)/.test(result.reason.message)) {
        anyOk = true;
        continue;
      }
      continue;
    }
    anyOk = true;
    const list = listSchema.safeParse(result.value);
    if (!list.success) continue;
    for (const row of list.data) {
      const event = toEvent(row, topic, today);
      if (!event) continue;
      const key = `${event.title}:${event.startsAt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }

  if (!anyOk) {
    if (lastError instanceof SourceError) throw lastError;
    throw new SourceError("did not answer");
  }
  return events;
}
