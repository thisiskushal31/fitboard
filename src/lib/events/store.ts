import "server-only";

import { createHash } from "node:crypto";

import type { Prisma, EventOpportunity } from "@/generated/prisma/client";
import type { ProfileData } from "@/lib/profile/profile";
import { prisma } from "@/lib/core/prisma";
import { loadProfile } from "@/lib/profile/profile-data";
import { placeOf, reach, type Place } from "@/lib/startups/place";

import { matchEvent, MATCH_VERSION } from "./match";
import {
  EVENT_FORMATS,
  EVENT_SOURCES,
  EVENT_STATUSES,
  type EventFilter,
  type EventFormatName,
  type EventSource,
  type EventStatusName,
  type EventView,
  type FoundEvent,
} from "./types";

// Engagement → Events store: upsert, score, list, and remove opportunities.

const STALE_DAYS = 60;
const DAY_MS = 86_400_000;

const strings = (value: Prisma.JsonValue | null): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

export function eventView(row: EventOpportunity): EventView {
  const format = (EVENT_FORMATS as readonly string[]).includes(row.format) ? (row.format as EventFormatName) : "UNKNOWN";
  return {
    id: row.id,
    source: (EVENT_SOURCES as readonly string[]).includes(row.source) ? (row.source as EventSource) : "TECHCONF",
    externalId: row.externalId,
    title: row.title,
    summary: row.summary,
    url: row.url,
    place: row.place,
    city: row.city,
    country: row.country,
    remote: row.remote,
    format,
    startsAt: row.startsAt?.toISOString() ?? null,
    endsAt: row.endsAt?.toISOString() ?? null,
    ticketPrice: row.ticketPrice,
    speakers: strings(row.speakers),
    attendance: row.attendance,
    audience: row.audience,
    score: row.score,
    proximity: row.proximity,
    reasons: strings(row.reasons),
    status: (EVENT_STATUSES as readonly string[]).includes(row.status) ? (row.status as EventStatusName) : "NEW",
    notes: row.notes,
  };
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function blockHashes(event: Pick<FoundEvent, "source" | "externalId" | "url">): string[] {
  return [hash(`event:${event.source}:${event.externalId}`), hash(`url:${event.url}`)];
}

async function scoring(): Promise<{ profile: ProfileData; place: Place }> {
  const profile = await loadProfile();
  return { profile, place: placeOf(profile.basics) };
}

/** Keeps what a refresh found; returns how many were new. */
export async function upsertEvents(found: readonly FoundEvent[], now = new Date()): Promise<number> {
  const { profile, place } = await scoring();
  const blocked = new Set((await prisma.eventBlock.findMany({ select: { hash: true } })).map((row) => row.hash));
  const existing = new Map(
    (await prisma.eventOpportunity.findMany({ select: { source: true, externalId: true, url: true } })).map((row) => [`${row.source}:${row.externalId}`, row]),
  );
  const seen = new Set<string>();
  const creates: Prisma.EventOpportunityCreateManyInput[] = [];
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  for (const event of found) {
    const key = `${event.source}:${event.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const known = existing.get(key);
    if (!known && blockHashes(event).some((entry) => blocked.has(entry))) continue;
    const fit = matchEvent(event, profile, place, now);
    const fields = {
      title: event.title.slice(0, 300),
      summary: event.summary.slice(0, 50_000),
      url: (event.url || known?.url || "").slice(0, 2000),
      place: event.place.slice(0, 300),
      city: event.city.slice(0, 120),
      country: event.country.slice(0, 8),
      remote: event.remote,
      format: event.format,
      startsAt: event.startsAt ? new Date(event.startsAt) : null,
      endsAt: event.endsAt ? new Date(event.endsAt) : null,
      ticketPrice: event.ticketPrice.slice(0, 120),
      speakers: event.speakers.slice(0, 20),
      attendance: event.attendance,
      audience: event.audience.slice(0, 200),
      seenAt: now,
      score: fit.score,
      proximity: fit.proximity,
      reasons: fit.reasons,
      scoredWith: MATCH_VERSION,
    };
    if (known) {
      updates.push(prisma.eventOpportunity.update({ where: { source_externalId: { source: event.source, externalId: event.externalId } }, data: fields }));
    } else {
      creates.push({ source: event.source, externalId: event.externalId, ...fields });
    }
  }
  for (let index = 0; index < creates.length; index += 200) {
    await prisma.eventOpportunity.createMany({ data: creates.slice(index, index + 200), skipDuplicates: true });
  }
  for (let index = 0; index < updates.length; index += 50) {
    await prisma.$transaction(updates.slice(index, index + 50));
  }
  return creates.length;
}

export async function rescoreEvents(now = new Date()): Promise<void> {
  const { profile, place } = await scoring();
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  for (const row of await prisma.eventOpportunity.findMany({ where: { status: { not: "DISMISSED" } } })) {
    const fit = matchEvent(eventView(row), profile, place, now);
    if (fit.score !== row.score || fit.proximity !== row.proximity || JSON.stringify(fit.reasons) !== JSON.stringify(row.reasons)) {
      updates.push(
        prisma.eventOpportunity.update({
          where: { id: row.id },
          data: { score: fit.score, proximity: fit.proximity, reasons: fit.reasons, scoredWith: MATCH_VERSION },
        }),
      );
    }
  }
  for (let index = 0; index < updates.length; index += 50) {
    await prisma.$transaction(updates.slice(index, index + 50));
  }
}

function inPlace(event: EventView, filter: EventFilter["place"], place: Place): boolean {
  if (filter === "any") return true;
  const where = reach(`${event.place} ${event.city} ${event.country} ${event.title}`, place);
  if (filter === "remote") return Boolean(event.remote) || event.format === "VIRTUAL" || event.format === "HYBRID" || (where.remote && where.remoteOpen !== false);
  if (filter === "city") return where.here === "city";
  return where.here !== null;
}

export type EventList = { events: EventView[]; total: number; counts: Record<EventStatusName, number> };

export async function listEvents(filter: EventFilter, place: Place, { limit = 100 }: { limit?: number } = {}): Promise<EventList> {
  const [rows, grouped] = await Promise.all([
    prisma.eventOpportunity.findMany({
      where: {
        status: filter.status,
        ...(filter.source ? { source: filter.source } : {}),
        ...(filter.format ? { format: filter.format } : {}),
        ...(filter.minScore > 0 ? { score: { gte: filter.minScore } } : {}),
      },
      orderBy:
        filter.sort === "soon"
          ? [{ startsAt: { sort: "asc", nulls: "last" } }, { proximity: "asc" }]
          : filter.sort === "match"
            ? [{ score: "desc" }, { proximity: "asc" }, { startsAt: { sort: "asc", nulls: "last" } }]
            : [{ proximity: "asc" }, { score: "desc" }, { startsAt: { sort: "asc", nulls: "last" } }],
    }),
    prisma.eventOpportunity.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const words = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = rows.map(eventView).filter((event) => {
    if (!inPlace(event, filter.place, place)) return false;
    if (words.length === 0) return true;
    const text = [event.title, event.summary, event.place, event.city, event.ticketPrice, ...event.speakers].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const counts: Record<EventStatusName, number> = { NEW: 0, SAVED: 0, DISMISSED: 0 };
  for (const group of grouped) {
    if ((EVENT_STATUSES as readonly string[]).includes(group.status)) counts[group.status as EventStatusName] = group._count._all;
  }
  return { events: matching.slice(0, limit), total: matching.length, counts };
}

export async function getEvent(id: string): Promise<EventView | null> {
  const row = await prisma.eventOpportunity.findUnique({ where: { id } });
  return row ? eventView(row) : null;
}

export async function updateEvent(id: string, change: { status?: EventStatusName; notes?: string }): Promise<EventView | null> {
  const data: Prisma.EventOpportunityUpdateInput = {};
  if (change.status) data.status = change.status;
  if (change.notes !== undefined) data.notes = change.notes.slice(0, 5_000);
  const { count } = await prisma.eventOpportunity.updateMany({ where: { id }, data });
  return count > 0 ? getEvent(id) : null;
}

export async function removeEvent(id: string): Promise<boolean> {
  const row = await prisma.eventOpportunity.findUnique({ where: { id } });
  if (!row) return false;
  await prisma.$transaction([
    prisma.eventBlock.createMany({ data: blockHashes(eventView(row)).map((entry) => ({ hash: entry })), skipDuplicates: true }),
    prisma.eventOpportunity.delete({ where: { id } }),
  ]);
  return true;
}

export async function sweepEvents(now = new Date()): Promise<{ removed: number }> {
  const { count: removed } = await prisma.eventOpportunity.deleteMany({
    where: {
      status: { in: ["NEW", "DISMISSED"] },
      OR: [{ startsAt: { lt: now } }, { seenAt: { lt: new Date(now.getTime() - STALE_DAYS * DAY_MS) } }],
    },
  });
  return { removed };
}
