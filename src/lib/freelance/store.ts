import "server-only";

import { createHash } from "node:crypto";

import type { Prisma, FreelanceOpportunity } from "@/generated/prisma/client";
import { ApplicationStatus, FreelanceStatus } from "@/generated/prisma/enums";
import type { ProfileData } from "@/lib/profile/profile";
import { prisma } from "@/lib/core/prisma";
import { loadProfile } from "@/lib/profile/profile-data";
import { placeOf, reach, type Place } from "@/lib/startups/place";

import { matchFreelance, MATCH_VERSION } from "./match";
import {
  FREELANCE_ENGAGEMENTS,
  FREELANCE_SOURCES,
  FREELANCE_STATUSES,
  type FoundFreelance,
  type FreelanceEngagementName,
  type FreelanceFilter,
  type FreelanceSource,
  type FreelanceStatusName,
  type FreelanceView,
} from "./types";

// Engagement → Freelance store: upsert, score, list, and remove opportunities.

const STALE_DAYS = 45;
const DAY_MS = 86_400_000;

const strings = (value: Prisma.JsonValue | null): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);

export function freelanceView(row: FreelanceOpportunity): FreelanceView {
  const engagement = (FREELANCE_ENGAGEMENTS as readonly string[]).includes(row.engagement) ? (row.engagement as FreelanceEngagementName) : "CONTRACT";
  return {
    id: row.id,
    source: (FREELANCE_SOURCES as readonly string[]).includes(row.source) ? (row.source as FreelanceSource) : "HN",
    externalId: row.externalId,
    title: row.title,
    company: row.company,
    place: row.place,
    remote: row.remote,
    engagement,
    budget: row.budget,
    duration: row.duration,
    url: row.url,
    description: row.description,
    postedAt: row.postedAt?.toISOString() ?? null,
    score: row.score,
    reasons: strings(row.reasons),
    status: row.status,
    notes: row.notes,
    applicationId: row.applicationId,
  };
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export function blockHashes(gig: Pick<FoundFreelance, "source" | "externalId" | "url">): string[] {
  return [hash(`gig:${gig.source}:${gig.externalId}`), hash(`url:${gig.url}`)];
}

async function scoring(): Promise<{ profile: ProfileData; place: Place }> {
  const profile = await loadProfile();
  return { profile, place: placeOf(profile.basics) };
}

/** Keeps what a refresh found; returns how many were new. */
export async function upsertFreelance(found: readonly FoundFreelance[], now = new Date()): Promise<number> {
  const { profile, place } = await scoring();
  const blocked = new Set((await prisma.freelanceBlock.findMany({ select: { hash: true } })).map((row) => row.hash));
  const existing = new Map(
    (await prisma.freelanceOpportunity.findMany({ select: { source: true, externalId: true, url: true } })).map((row) => [`${row.source}:${row.externalId}`, row]),
  );
  const seen = new Set<string>();
  const creates: Prisma.FreelanceOpportunityCreateManyInput[] = [];
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  for (const gig of found) {
    const key = `${gig.source}:${gig.externalId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const known = existing.get(key);
    if (!known && blockHashes(gig).some((entry) => blocked.has(entry))) continue;
    const fit = matchFreelance(gig, profile, place, now);
    const fields = {
      title: gig.title.slice(0, 300),
      company: gig.company.slice(0, 200),
      place: gig.place.slice(0, 300),
      remote: gig.remote,
      engagement: gig.engagement,
      budget: gig.budget.slice(0, 120),
      duration: gig.duration.slice(0, 120),
      url: (gig.url || known?.url || "").slice(0, 2000),
      description: gig.description.slice(0, 50_000),
      postedAt: gig.postedAt ? new Date(gig.postedAt) : null,
      seenAt: now,
      score: fit.score,
      reasons: fit.reasons,
      scoredWith: MATCH_VERSION,
    };
    if (known) {
      updates.push(prisma.freelanceOpportunity.update({ where: { source_externalId: { source: gig.source, externalId: gig.externalId } }, data: fields }));
    } else {
      creates.push({ source: gig.source, externalId: gig.externalId, ...fields });
    }
  }
  for (let index = 0; index < creates.length; index += 200) {
    await prisma.freelanceOpportunity.createMany({ data: creates.slice(index, index + 200), skipDuplicates: true });
  }
  for (let index = 0; index < updates.length; index += 50) {
    await prisma.$transaction(updates.slice(index, index + 50));
  }
  return creates.length;
}

export async function rescoreFreelance(now = new Date()): Promise<void> {
  const { profile, place } = await scoring();
  const updates: Prisma.PrismaPromise<unknown>[] = [];
  for (const row of await prisma.freelanceOpportunity.findMany({ where: { status: { not: FreelanceStatus.DISMISSED } } })) {
    const fit = matchFreelance(freelanceView(row), profile, place, now);
    if (fit.score !== row.score || JSON.stringify(fit.reasons) !== JSON.stringify(row.reasons)) {
      updates.push(
        prisma.freelanceOpportunity.update({
          where: { id: row.id },
          data: { score: fit.score, reasons: fit.reasons, scoredWith: MATCH_VERSION },
        }),
      );
    }
  }
  for (let index = 0; index < updates.length; index += 50) {
    await prisma.$transaction(updates.slice(index, index + 50));
  }
}

export async function markSentAsContacted(): Promise<number> {
  const { count } = await prisma.freelanceOpportunity.updateMany({
    where: { status: { in: [FreelanceStatus.NEW, FreelanceStatus.SAVED] }, application: { status: { not: ApplicationStatus.DRAFT } } },
    data: { status: FreelanceStatus.CONTACTED },
  });
  return count;
}

function inPlace(gig: FreelanceView, filter: FreelanceFilter["place"], place: Place): boolean {
  if (filter === "any") return true;
  const where = reach(`${gig.place} ${gig.title}`, place);
  if (filter === "remote") return Boolean(gig.remote) || (where.remote && where.remoteOpen !== false);
  if (filter === "city") return where.here === "city";
  return where.here !== null;
}

export type FreelanceList = { opportunities: FreelanceView[]; total: number; counts: Record<FreelanceStatusName, number> };

export async function listFreelance(filter: FreelanceFilter, place: Place, { limit = 100 }: { limit?: number } = {}): Promise<FreelanceList> {
  await markSentAsContacted();
  const [rows, grouped] = await Promise.all([
    prisma.freelanceOpportunity.findMany({
      where: {
        status: filter.status,
        ...(filter.source ? { source: filter.source } : {}),
        ...(filter.engagement ? { engagement: filter.engagement } : {}),
        ...(filter.minScore > 0 ? { score: { gte: filter.minScore } } : {}),
      },
      orderBy: filter.sort === "newest" ? [{ postedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }] : [{ score: "desc" }, { postedAt: { sort: "desc", nulls: "last" } }],
    }),
    prisma.freelanceOpportunity.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);
  const words = filter.q.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = rows.map(freelanceView).filter((gig) => {
    if (!inPlace(gig, filter.place, place)) return false;
    if (words.length === 0) return true;
    const text = [gig.title, gig.company, gig.description, gig.place, gig.budget].join(" ").toLowerCase();
    return words.every((word) => text.includes(word));
  });
  const counts: Record<FreelanceStatusName, number> = { NEW: 0, SAVED: 0, CONTACTED: 0, DISMISSED: 0 };
  for (const group of grouped) {
    if ((FREELANCE_STATUSES as readonly string[]).includes(group.status)) counts[group.status as FreelanceStatusName] = group._count._all;
  }
  return { opportunities: matching.slice(0, limit), total: matching.length, counts };
}

export async function getFreelance(id: string): Promise<FreelanceView | null> {
  const row = await prisma.freelanceOpportunity.findUnique({ where: { id } });
  return row ? freelanceView(row) : null;
}

export async function updateFreelance(id: string, change: { status?: FreelanceStatus; notes?: string }): Promise<FreelanceView | null> {
  const data: Prisma.FreelanceOpportunityUpdateInput = {};
  if (change.status) data.status = change.status;
  if (change.notes !== undefined) data.notes = change.notes.slice(0, 5_000);
  const { count } = await prisma.freelanceOpportunity.updateMany({ where: { id }, data });
  return count > 0 ? getFreelance(id) : null;
}

export async function removeFreelance(id: string): Promise<boolean> {
  const row = await prisma.freelanceOpportunity.findUnique({ where: { id } });
  if (!row) return false;
  await prisma.$transaction([
    prisma.freelanceBlock.createMany({ data: blockHashes(freelanceView(row)).map((entry) => ({ hash: entry })), skipDuplicates: true }),
    prisma.freelanceOpportunity.delete({ where: { id } }),
  ]);
  return true;
}

export async function sweepFreelance(now = new Date()): Promise<{ removed: number }> {
  const { count: removed } = await prisma.freelanceOpportunity.deleteMany({
    where: {
      status: { in: [FreelanceStatus.NEW, FreelanceStatus.DISMISSED] },
      applicationId: null,
      seenAt: { lt: new Date(now.getTime() - STALE_DAYS * DAY_MS) },
    },
  });
  return { removed };
}

/** What New application starts from: the gig as a posting to read. */
export function freelancePostingText(gig: FreelanceView): string {
  return [
    gig.title,
    gig.company && `Client: ${gig.company}`,
    gig.place && `Location: ${gig.place}`,
    gig.budget && `Budget: ${gig.budget}`,
    gig.duration && `Duration: ${gig.duration}`,
    gig.description,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();
}
