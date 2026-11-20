import "server-only";

import { readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { getText, settledInBatches, SourceError } from "./http";
import { eventsFromIcs } from "./ics";
import { normalizeEventPlace } from "../place";
import type { FoundEvent } from "../types";

// Meetup: public per-group iCal calendars.

/** Group calendars fetched at once. */
const CONCURRENCY = 6;

const groupSchema = z.object({ slug: z.string().min(1).max(120), name: z.string().min(1).max(200) });
const groupsSchema = z.array(groupSchema).min(1);

const icalUrl = (slug: string) => `https://www.meetup.com/${encodeURIComponent(slug)}/events/ical/`;
const pageUrl = (slug: string, uid: string) => {
  const id = uid.match(/(\d{8,})/)?.[1];
  return id ? `https://www.meetup.com/${encodeURIComponent(slug)}/events/${id}/` : `https://www.meetup.com/${encodeURIComponent(slug)}/`;
};

async function loadGroups(): Promise<z.infer<typeof groupsSchema>> {
  try {
    const file = path.join(process.cwd(), "config", "meetup-groups.json");
    const parsed = groupsSchema.safeParse(JSON.parse(await readFile(file, "utf8")));
    if (!parsed.success) throw new SourceError("meetup groups config is invalid");
    return parsed.data;
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("meetup groups config couldn't be read");
  }
}

function attendanceFrom(description: string): number | null {
  const match = description.match(/\b(\d{1,5})\s+(?:going|attendees|RSVPs?)\b/i);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Meetup public iCal feeds for curated tech groups. */
export async function fetchMeetupEvents(signal?: AbortSignal, now = new Date()): Promise<FoundEvent[]> {
  const groups = await loadGroups();
  const results = await settledInBatches(groups, CONCURRENCY, (group) => getText(icalUrl(group.slug), { signal }));
  const events: FoundEvent[] = [];
  const seen = new Set<string>();
  let anyOk = false;
  let lastError: unknown;
  const today = now.getTime();

  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const group = groups[index];
    if (result.status !== "fulfilled") {
      lastError = result.reason;
      continue;
    }
    anyOk = true;
    for (const item of eventsFromIcs(result.value)) {
      if (!item.summary) continue;
      const starts = item.startsAt ? Date.parse(item.startsAt) : NaN;
      if (Number.isFinite(starts) && starts < today - 12 * 60 * 60 * 1000) continue;
      const externalId = `${group.slug}:${item.uid}`;
      if (seen.has(externalId)) continue;
      seen.add(externalId);
      const location = item.location;
      const url = item.url || pageUrl(group.slug, item.uid);
      const isRemote = /\b(online|virtual|zoom|remote)\b/i.test(`${location} ${item.summary} ${item.description}`);
      const where = normalizeEventPlace({ location, online: isRemote && (!location || /^(?:remote|online|virtual)$/i.test(location.trim())) });
      events.push({
        source: "MEETUP",
        externalId: externalId.slice(0, 300),
        title: item.summary.slice(0, 300),
        summary: [item.description.slice(0, 4000), `Hosted by ${group.name}`].filter(Boolean).join("\n\n"),
        url: url.slice(0, 2000),
        place: where.place || location.slice(0, 300),
        city: where.city,
        country: where.country,
        remote: isRemote ? true : location ? false : null,
        format: isRemote ? "VIRTUAL" : location ? "IN_PERSON" : "UNKNOWN",
        startsAt: item.startsAt,
        endsAt: item.endsAt,
        ticketPrice: /\bfree\b/i.test(item.description) ? "Free" : "",
        speakers: [],
        attendance: attendanceFrom(item.description),
        audience: "",
      });
    }
  }

  if (!anyOk) {
    if (lastError instanceof SourceError) throw lastError;
    throw new SourceError("did not answer");
  }
  return events;
}
