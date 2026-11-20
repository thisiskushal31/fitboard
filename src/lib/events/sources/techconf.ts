import "server-only";

import { z } from "zod";

import { getJson, SourceError } from "./http";
import { normalizeEventPlace } from "../place";
import type { FoundEvent } from "../types";

// TechConf.Directory: public conferences JSON.

const ENDPOINT = "https://techconf.directory/api/conferences.json";
const SITE = "https://techconf.directory";

const locationSchema = z.object({
  country: z.string().optional(),
  city: z.string().optional(),
});

const datesSchema = z.object({
  start: z.string().optional(),
  end: z.string().optional(),
});

const upcomingSchema = z.object({
  dates: datesSchema.optional(),
  format: z.string().optional(),
  location: locationSchema.optional(),
});

const conferenceSchema = z.object({
  id: z.string(),
  title: z.string(),
  tags: z.array(z.string()).optional(),
  upcoming_events: z.record(z.string(), upcomingSchema).optional(),
});

const payloadSchema = z.object({ data: z.array(z.unknown()) }).or(z.array(z.unknown()));

function formatOf(value: string | undefined): FoundEvent["format"] {
  const raw = (value ?? "").toLowerCase();
  if (raw === "in-person" || raw === "in_person") return "IN_PERSON";
  if (raw === "virtual" || raw === "online") return "VIRTUAL";
  if (raw === "hybrid") return "HYBRID";
  return "UNKNOWN";
}

function dayStart(isoDate: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  return `${isoDate}T00:00:00.000Z`;
}

/** TechConf.Directory's open conference list — upcoming dated events only. */
export async function fetchTechConfEvents(signal?: AbortSignal, now = new Date()): Promise<FoundEvent[]> {
  let raw: unknown;
  try {
    raw = await getJson(ENDPOINT, { signal });
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("couldn't be reached");
  }

  const payload = payloadSchema.safeParse(raw);
  if (!payload.success) throw new SourceError("changed its format");
  const rows = Array.isArray(payload.data) ? payload.data : payload.data.data;
  const today = now.toISOString().slice(0, 10);
  const events: FoundEvent[] = [];

  for (const row of rows) {
    const parsed = conferenceSchema.safeParse(row);
    if (!parsed.success) continue;
    const conf = parsed.data;
    const upcoming = conf.upcoming_events ?? {};
    for (const [year, entry] of Object.entries(upcoming)) {
      const start = entry.dates?.start?.trim() ?? "";
      if (!start || start < today) continue;
      const format = formatOf(entry.format);
      const remote = format === "VIRTUAL" ? true : format === "HYBRID" ? true : format === "IN_PERSON" ? false : null;
      const where = normalizeEventPlace({
        city: entry.location?.city?.trim() ?? "",
        country: entry.location?.country?.trim() ?? "",
        online: format === "VIRTUAL",
      });
      const tags = (conf.tags ?? []).filter(Boolean);
      events.push({
        source: "TECHCONF",
        externalId: `${conf.id}:${year}:${start}`,
        title: conf.title.slice(0, 300),
        summary: tags.length > 0 ? `Topics: ${tags.join(", ")}` : "",
        url: `${SITE}/conferences/${encodeURIComponent(conf.id)}`,
        place: where.place,
        city: where.city,
        country: where.country,
        remote,
        format,
        startsAt: dayStart(start),
        endsAt: entry.dates?.end ? dayStart(entry.dates.end) : null,
        ticketPrice: "",
        speakers: [],
        attendance: null,
        audience: "",
      });
    }
  }
  return events;
}
