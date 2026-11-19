import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings } from "@/lib/settings/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { placeOf } from "@/lib/startups/place";
import { refreshFreelance, refreshFreelanceJob } from "@/lib/freelance/refresh";
import {
  blockHashes,
  freelancePostingText,
  getFreelance,
  listFreelance,
  removeFreelance,
  rescoreFreelance,
  sweepFreelance,
  updateFreelance,
  upsertFreelance,
} from "@/lib/freelance/store";
import { freelanceFilterSchema, type FoundFreelance } from "@/lib/freelance/types";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/core/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const profile = vi.hoisted(() => ({
  basics: { headline: "Android engineer", summary: "", city: "Berlin", country: "Germany" },
  skills: [
    { id: "1", name: "Android" },
    { id: "2", name: "Kotlin" },
  ],
  experience: [],
}));
vi.mock("@/lib/profile/profile-data", () => ({ loadProfile: async () => profile }));
vi.mock("@/lib/core/log", () => ({ logServerError: vi.fn() }));

const sources = vi.hoisted(() => ({
  hn: [] as FoundFreelance[],
  remotive: [] as FoundFreelance[],
  wwr: [] as FoundFreelance[],
  freelancer: [] as FoundFreelance[],
  remoteok: [] as FoundFreelance[],
  hnFails: false,
}));
vi.mock("@/lib/freelance/sources/hn", async () => {
  const { SourceError } = await import("@/lib/freelance/sources/http");
  return {
    fetchHnFreelance: async () => {
      if (sources.hnFails) throw new SourceError("took too long to answer");
      return sources.hn;
    },
  };
});
vi.mock("@/lib/freelance/sources/remotive", () => ({
  fetchRemotiveFreelance: async () => sources.remotive,
}));
vi.mock("@/lib/freelance/sources/wwr", () => ({
  fetchWwrFreelance: async () => sources.wwr,
}));
vi.mock("@/lib/freelance/sources/freelancer", () => ({
  fetchFreelancerFreelance: async () => sources.freelancer,
}));
vi.mock("@/lib/freelance/sources/remoteok", () => ({
  fetchRemoteOkFreelance: async () => sources.remoteok,
}));

const prisma = () => db.client!;
const berlin = placeOf(profile.basics);
const filter = (change: object = {}) => freelanceFilterSchema.parse(change);
const gig = (change: Partial<FoundFreelance> = {}): FoundFreelance => ({
  source: "HN",
  externalId: "1",
  title: "Android contract — build farm apps",
  company: "Acme",
  place: "Berlin, Germany",
  remote: false,
  engagement: "CONTRACT",
  budget: "$80/hr",
  duration: "3 months",
  url: "https://news.ycombinator.com/item?id=1",
  description: "Need an Android / Kotlin contractor for farmer apps in Berlin.",
  postedAt: "2026-10-20T12:00:00Z",
  ...change,
});
const now = new Date("2026-10-23T12:00:00Z");

beforeEach(async () => {
  await resetDatabase(prisma());
  sources.hn = [];
  sources.remotive = [];
  sources.wwr = [];
  sources.freelancer = [];
  sources.remoteok = [];
  sources.hnFails = false;
});
afterAll(() => prisma().$disconnect());

describe("keeping freelance opportunities", () => {
  it("adds new gigs, scored, and updates known ones without losing what the user did", async () => {
    expect(await upsertFreelance([gig(), gig()], now)).toBe(1);
    const [row] = await prisma().freelanceOpportunity.findMany();
    expect(row).toMatchObject({ title: "Android contract — build farm apps", status: "NEW", scoredWith: "freelance-match@1" });
    expect(row.score).toBeGreaterThan(50);

    await prisma().freelanceOpportunity.update({ where: { id: row.id }, data: { status: "SAVED", notes: "Ask about Compose" } });
    expect(await upsertFreelance([gig({ description: "Now with tractors", url: "" })], now)).toBe(0);
    expect(await getFreelance(row.id)).toMatchObject({
      description: "Now with tractors",
      url: "https://news.ycombinator.com/item?id=1",
      status: "SAVED",
      notes: "Ask about Compose",
    });
  });

  it("leaves out gigs removed for good", async () => {
    await upsertFreelance([gig()], now);
    const [row] = await prisma().freelanceOpportunity.findMany();
    expect(await removeFreelance(row.id)).toBe(true);
    expect(await removeFreelance(row.id)).toBe(false);
    const blocks = await prisma().freelanceBlock.findMany();
    expect(blocks.map((block) => block.hash).sort()).toEqual(blockHashes(gig()).sort());

    expect(await upsertFreelance([gig(), gig({ externalId: "2", url: "https://news.ycombinator.com/item?id=1" })], now)).toBe(0);
    expect(await upsertFreelance([gig({ externalId: "4", title: "Fresh gig", url: "https://fresh.example/1" })], now)).toBe(1);
  });

  it("lists by view, source, engagement, match, place and words", async () => {
    await upsertFreelance(
      [
        gig(),
        gig({
          externalId: "2",
          title: "Remote React contract",
          company: "Remote Co",
          place: "REMOTE (EU)",
          remote: true,
          engagement: "PROJECT",
          description: "Remote React project",
          postedAt: "2026-10-22T12:00:00Z",
        }),
        gig({
          source: "WWR",
          externalId: "3",
          title: "Temporary ops in Austin",
          company: "Faraway",
          place: "Austin, TX",
          remote: false,
          engagement: "TEMPORARY",
          description: "Short ops gig",
          postedAt: null,
        }),
        gig({
          externalId: "4",
          title: "Munich Kotlin contract",
          company: "Munich Co",
          place: "Munich, Germany",
          description: "Kotlin contract in Munich",
          postedAt: "2026-10-19T12:00:00Z",
        }),
      ],
      now,
    );
    const titles = async (change: object) => (await listFreelance(filter(change), berlin)).opportunities.map((entry) => entry.company);
    expect(await titles({})).toEqual(["Acme", "Munich Co", "Remote Co", "Faraway"]);
    expect(await titles({ sort: "newest" })).toEqual(["Remote Co", "Acme", "Munich Co", "Faraway"]);
    expect(await titles({ place: "city" })).toEqual(["Acme"]);
    expect(await titles({ place: "country" })).toEqual(["Acme", "Munich Co"]);
    expect(await titles({ place: "remote" })).toEqual(["Remote Co"]);
    expect(await titles({ source: "WWR" })).toEqual(["Faraway"]);
    expect(await titles({ engagement: "PROJECT" })).toEqual(["Remote Co"]);
    expect(await titles({ q: "remote co" })).toEqual(["Remote Co"]);
    expect(await titles({ minScore: 70 })).toEqual(["Acme"]);

    const [faraway] = (await listFreelance(filter({ source: "WWR" }), berlin)).opportunities;
    await updateFreelance(faraway.id, { status: "DISMISSED", notes: "Too far" });
    const list = await listFreelance(filter({ status: "DISMISSED" }), berlin, { limit: 1 });
    expect(list).toMatchObject({ total: 1, counts: { NEW: 3, SAVED: 0, CONTACTED: 0, DISMISSED: 1 } });
    expect(list.opportunities[0].notes).toBe("Too far");
    expect(await updateFreelance("missing", { status: "SAVED" })).toBeNull();
  });

  it("removes stale untouched gigs", async () => {
    await upsertFreelance(
      [gig(), gig({ externalId: "2", title: "Kept", url: "https://a.example/2" }), gig({ externalId: "3", title: "Linked", url: "https://a.example/3" }), gig({ externalId: "4", title: "Fresh", url: "https://a.example/4" })],
      new Date("2026-08-01T00:00:00Z"),
    );
    await upsertFreelance([gig({ externalId: "4", title: "Fresh", url: "https://a.example/4" })], now);
    const rows = Object.fromEntries((await prisma().freelanceOpportunity.findMany()).map((row) => [row.title, row]));
    await prisma().freelanceOpportunity.update({ where: { id: rows.Kept.id }, data: { status: "SAVED" } });
    const application = await prisma().application.create({ data: { title: "Linked" } });
    await prisma().freelanceOpportunity.update({ where: { id: rows.Linked.id }, data: { applicationId: application.id } });

    expect(await sweepFreelance(now)).toEqual({ removed: 1 });
    expect((await prisma().freelanceOpportunity.findMany({ orderBy: { title: "asc" } })).map((row) => row.title)).toEqual(["Fresh", "Kept", "Linked"]);
  });

  it("scores again after the profile changed", async () => {
    await upsertFreelance([gig()], now);
    profile.skills = [];
    await rescoreFreelance(now);
    const [row] = await prisma().freelanceOpportunity.findMany();
    expect(row.reasons).not.toContainEqual(expect.stringMatching(/skills/));
    profile.skills = [
      { id: "1", name: "Android" },
      { id: "2", name: "Kotlin" },
    ];
  });

  it("hands New application the gig's text", async () => {
    await upsertFreelance([gig()], now);
    const [row] = await prisma().freelanceOpportunity.findMany();
    const text = freelancePostingText((await getFreelance(row.id))!);
    expect(text).toContain("Android contract — build farm apps");
    expect(text).toContain("Client: Acme");
    expect(text).toContain("Budget: $80/hr");
    expect(text).toContain("Kotlin");
  });
});

describe("refreshing freelance", () => {
  it("keeps what sources found and says which failed", async () => {
    sources.remotive = [gig({ source: "REMOTIVE", externalId: "r1", url: "https://remotive.com/1" })];
    sources.wwr = [gig({ source: "WWR", externalId: "w1", url: "https://weworkremotely.com/1" })];
    sources.freelancer = [gig({ source: "FREELANCER", externalId: "f1", url: "https://freelancer.com/projects/1" })];
    sources.remoteok = [gig({ source: "REMOTEOK", externalId: "o1", url: "https://remoteok.com/remote-jobs/1" })];
    sources.hnFails = true;
    const steps: string[] = [];
    const result = await refreshFreelance(async (name) => void steps.push(name), new AbortController().signal, now);
    expect(result).toEqual({
      at: now.toISOString(),
      added: 4,
      sources: [
        { source: "HN", found: 0, error: "Hacker News took too long to answer" },
        { source: "REMOTIVE", found: 1, error: null },
        { source: "WWR", found: 1, error: null },
        { source: "FREELANCER", found: 1, error: null },
        { source: "REMOTEOK", found: 1, error: null },
      ],
    });
    expect(steps[0]).toBe("Looking for freelance and contract gigs");
    expect(steps[1]).toMatch(/^Scoring 4 /);
    expect((await loadSettings()).freelanceLastRefresh).toEqual(result);

    await refreshFreelanceJob.run({}, { step: async () => {}, signal: new AbortController().signal } as never);
  });
});
