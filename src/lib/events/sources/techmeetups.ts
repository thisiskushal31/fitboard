import "server-only";

import { z } from "zod";

import { countryCodeFor } from "@/lib/job-search/countries";

import { getJson, settledInBatches, SourceError } from "./http";
import type { FoundEvent } from "../types";

// TechMeetups: public conference search API by focus.

/** Focus searches fetched at once. */
const CONCURRENCY = 3;

const BASE = "https://techmeetups.io/api/v1/conferences/search";

const FOCUSES = ["software-engineering", "ai-ml", "product-ux-design", "startups", "it-leadership"] as const;

const conferenceSchema = z.object({
  id: z.string(),
  name: z.string(),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  location: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  focus: z.string().nullable().optional(),
  topics: z.array(z.string()).optional(),
  description: z.string().nullable().optional(),
  cost: z.string().nullable().optional(),
  registration_url: z.string().nullable().optional(),
  url: z.string().optional(),
  organizer: z.string().nullable().optional(),
});

const searchSchema = z.object({
  results: z.array(z.unknown()),
  total_matches: z.number().optional(),
});

function dayStart(isoDate: string | null | undefined): string | null {
  if (!isoDate || !/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  return `${isoDate}T00:00:00.000Z`;
}

function formatOf(location: string, description: string): FoundEvent["format"] {
  const blob = `${location} ${description}`.toLowerCase();
  if (/\b(hybrid)\b/.test(blob)) return "HYBRID";
  if (/\b(virtual|online|remote)\b/.test(blob) && !/\b(in[-\s]?person)\b/.test(blob)) return "VIRTUAL";
  if (/\b(in[-\s]?person|onsite|on-site)\b/.test(blob)) return "IN_PERSON";
  if (!location.trim() || /^remote$/i.test(location.trim())) return "VIRTUAL";
  return "IN_PERSON";
}

function speakersFrom(description: string): string[] {
  const names: string[] = [];
  const patterns = [
    /(?:keynote|speaker|featuring|with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})/g,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2}),\s+(?:Chief|CEO|CTO|SVP|VP|Head|Founder)/g,
  ];
  for (const pattern of patterns) {
    for (const match of description.matchAll(pattern)) {
      const name = match[1]?.trim();
      if (name && name.length > 3 && name.length < 60 && !names.includes(name)) names.push(name);
      if (names.length >= 5) return names;
    }
  }
  return names;
}

function audienceFrom(description: string): string {
  if (/\b(students?|university|campus)\b/i.test(description)) return "Students and early career";
  if (/\b(executives?|c-level|leadership|directors?)\b/i.test(description)) return "Leaders and executives";
  if (/\b(senior|staff|principal)\b/i.test(description)) return "Senior practitioners";
  if (/\b(hackathon|builders?)\b/i.test(description)) return "Builders and hackers";
  return "";
}

function attendanceFrom(description: string): number | null {
  const match = description.match(/\b(\d{2,5})\s*(?:\+|plus)?\s*(?:attendees|participants|people|developers)\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function countryFromLocation(location: string): string {
  const parts = location.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return "";
  const last = parts[parts.length - 1];
  if (/^[A-Z]{2}$/.test(last)) return last.toLowerCase();
  return countryCodeFor(last) || "";
}

function toEvent(raw: unknown): FoundEvent | null {
  const parsed = conferenceSchema.safeParse(raw);
  if (!parsed.success) return null;
  const item = parsed.data;
  const title = item.name.trim();
  const url = (item.registration_url || item.url || "").trim();
  if (!title || !url) return null;
  const location = (item.location ?? "").trim();
  const description = (item.description ?? "").trim();
  const format = formatOf(location, description);
  const remote = format === "VIRTUAL" ? true : format === "HYBRID" ? true : false;
  const topics = item.topics ?? [];
  const focus = item.focus?.replace(/-/g, " ") ?? "";
  const summaryParts = [description.slice(0, 800), topics.length ? `Topics: ${topics.join(", ")}` : "", focus ? `Focus: ${focus}` : ""].filter(Boolean);
  return {
    source: "TECHMEETUPS",
    externalId: item.id,
    title: title.slice(0, 300),
    summary: summaryParts.join("\n\n").slice(0, 20_000),
    url: url.slice(0, 2000),
    place: location.slice(0, 300),
    city: (item.city ?? location.split(",")[0] ?? "").slice(0, 120),
    country: countryFromLocation(location).slice(0, 8),
    remote,
    format,
    startsAt: dayStart(item.start_date),
    endsAt: dayStart(item.end_date),
    ticketPrice: (item.cost ?? "").slice(0, 120),
    speakers: speakersFrom(description),
    attendance: attendanceFrom(description),
    audience: audienceFrom(description).slice(0, 200),
  };
}

async function searchFocus(focus: string, dateFrom: string, signal?: AbortSignal): Promise<FoundEvent[]> {
  const url = new URL(BASE);
  url.searchParams.set("focus", focus);
  url.searchParams.set("date_from", dateFrom);
  url.searchParams.set("limit", "50");
  const raw = await getJson(url.toString(), { signal });
  const parsed = searchSchema.safeParse(raw);
  if (!parsed.success) throw new SourceError("changed its format");
  return parsed.data.results.flatMap((row) => {
    const event = toEvent(row);
    return event ? [event] : [];
  });
}

/** TechMeetups public conference search — several focuses, upcoming only. */
export async function fetchTechMeetupsEvents(signal?: AbortSignal, now = new Date()): Promise<FoundEvent[]> {
  const dateFrom = now.toISOString().slice(0, 10);
  const results = await settledInBatches(FOCUSES, CONCURRENCY, (focus) => searchFocus(focus, dateFrom, signal));
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
