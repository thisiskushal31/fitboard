import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { loadSettings } from "@/lib/settings/settings-data";
import { createTestClient, resetDatabase } from "@/test/db";

import { placeOf } from "@/lib/startups/place";
import { refreshEvents, refreshEventsJob } from "@/lib/events/refresh";
import { PROXIMITY_CITY } from "@/lib/events/match";
import {
  blockHashes,
  getEvent,
  listEvents,
  removeEvent,
  rescoreEvents,
  updateEvent,
  upsertEvents,
} from "@/lib/events/store";
import { eventFilterSchema, type FoundEvent } from "@/lib/events/types";

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
  techconf: [] as FoundEvent[],
  techmeetups: [] as FoundEvent[],
  confstech: [] as FoundEvent[],
  meetup: [] as FoundEvent[],
  techconfFails: false,
}));
vi.mock("@/lib/events/sources/techconf", async () => {
  const { SourceError } = await import("@/lib/events/sources/http");
  return {
    fetchTechConfEvents: async () => {
      if (sources.techconfFails) throw new SourceError("took too long to answer");
      return sources.techconf;
    },
  };
});
vi.mock("@/lib/events/sources/techmeetups", () => ({
  fetchTechMeetupsEvents: async () => sources.techmeetups,
}));
vi.mock("@/lib/events/sources/confstech", () => ({
  fetchConfsTechEvents: async () => sources.confstech,
}));
vi.mock("@/lib/events/sources/meetup", () => ({
  fetchMeetupEvents: async () => sources.meetup,
}));

const prisma = () => db.client!;
const berlin = placeOf(profile.basics);
const filter = (change: object = {}) => eventFilterSchema.parse(change);
const event = (change: Partial<FoundEvent> = {}): FoundEvent => ({
  source: "TECHCONF",
  externalId: "1",
  title: "Android Dev Summit Berlin",
  summary: "Kotlin and Android for mobile engineers",
  url: "https://techconf.directory/conferences/android-berlin",
  place: "Berlin, Germany",
  city: "Berlin",
  country: "de",
  remote: false,
  format: "IN_PERSON",
  startsAt: "2026-12-10T00:00:00.000Z",
  endsAt: "2026-12-11T00:00:00.000Z",
  ticketPrice: "",
  speakers: ["Ada Lovelace"],
  attendance: 400,
  audience: "Senior practitioners",
  ...change,
});
const now = new Date("2026-11-19T12:00:00Z");

beforeEach(async () => {
  await resetDatabase(prisma());
  sources.techconf = [];
  sources.techmeetups = [];
  sources.confstech = [];
  sources.meetup = [];
  sources.techconfFails = false;
});
afterAll(() => prisma().$disconnect());

describe("keeping events", () => {
  it("adds new events, scored with proximity, and keeps user status on update", async () => {
    expect(await upsertEvents([event(), event()], now)).toBe(1);
    const [row] = await prisma().eventOpportunity.findMany();
    expect(row).toMatchObject({ title: "Android Dev Summit Berlin", status: "NEW", scoredWith: "events-match@1", proximity: PROXIMITY_CITY });
    expect(row.score).toBeGreaterThan(50);

    await prisma().eventOpportunity.update({ where: { id: row.id }, data: { status: "SAVED", notes: "Go with Sam" } });
    expect(await upsertEvents([event({ summary: "Updated crux", url: "" })], now)).toBe(0);
    expect(await getEvent(row.id)).toMatchObject({
      summary: "Updated crux",
      url: "https://techconf.directory/conferences/android-berlin",
      status: "SAVED",
      notes: "Go with Sam",
    });
  });

  it("leaves out events removed for good", async () => {
    await upsertEvents([event()], now);
    const [row] = await prisma().eventOpportunity.findMany();
    expect(await removeEvent(row.id)).toBe(true);
    expect(await removeEvent(row.id)).toBe(false);
    const blocks = await prisma().eventBlock.findMany();
    expect(blocks.map((block) => block.hash).sort()).toEqual(blockHashes(event()).sort());
    expect(await upsertEvents([event()], now)).toBe(0);
    expect(await upsertEvents([event({ externalId: "2", url: "https://example.com/2" })], now)).toBe(1);
  });

  it("lists by proximity first, then filters", async () => {
    await upsertEvents(
      [
        event(),
        event({
          externalId: "2",
          title: "Android Austin",
          place: "Austin, TX",
          city: "Austin",
          country: "us",
          url: "https://example.com/austin",
          startsAt: "2026-12-01T00:00:00.000Z",
        }),
        event({
          source: "TECHMEETUPS",
          externalId: "3",
          title: "Remote Kotlin",
          place: "Online",
          city: "",
          country: "",
          remote: true,
          format: "VIRTUAL",
          url: "https://example.com/remote",
          startsAt: "2026-11-25T00:00:00.000Z",
        }),
      ],
      now,
    );
    const titles = async (change: object) => (await listEvents(filter(change), berlin)).events.map((entry) => entry.title);
    expect(await titles({})).toEqual(["Android Dev Summit Berlin", "Remote Kotlin", "Android Austin"]);
    expect(await titles({ place: "city" })).toEqual(["Android Dev Summit Berlin"]);
    expect(await titles({ place: "remote" })).toEqual(["Remote Kotlin"]);
    expect(await titles({ source: "TECHMEETUPS" })).toEqual(["Remote Kotlin"]);
    expect(await titles({ sort: "soon" })).toEqual(["Remote Kotlin", "Android Austin", "Android Dev Summit Berlin"]);

    const [berlinEvent] = (await listEvents(filter({}), berlin)).events;
    await updateEvent(berlinEvent.id, { status: "DISMISSED", notes: "Clash" });
    const list = await listEvents(filter({ status: "DISMISSED" }), berlin);
    expect(list).toMatchObject({ total: 1, counts: { NEW: 2, SAVED: 0, DISMISSED: 1 } });
    expect(list.events[0].notes).toBe("Clash");
  });

  it("scores again after the profile changed", async () => {
    await upsertEvents([event()], now);
    profile.skills = [];
    await rescoreEvents(now);
    const [row] = await prisma().eventOpportunity.findMany();
    expect(row.reasons).not.toContainEqual(expect.stringMatching(/skills/));
    profile.skills = [
      { id: "1", name: "Android" },
      { id: "2", name: "Kotlin" },
    ];
  });
});

describe("refreshing events", () => {
  it("keeps what sources found and says which failed", async () => {
    sources.techmeetups = [event({ source: "TECHMEETUPS", externalId: "m1", url: "https://techmeetups.io/1" })];
    sources.confstech = [event({ source: "CONFSTECH", externalId: "c1", url: "https://confs.tech/1" })];
    sources.meetup = [event({ source: "MEETUP", externalId: "g1", url: "https://www.meetup.com/g/events/1/" })];
    sources.techconfFails = true;
    const steps: string[] = [];
    const result = await refreshEvents(async (name) => void steps.push(name), new AbortController().signal, now);
    expect(result).toEqual({
      at: now.toISOString(),
      added: 3,
      sources: [
        { source: "TECHCONF", found: 0, error: "TechConf.Directory took too long to answer" },
        { source: "TECHMEETUPS", found: 1, error: null },
        { source: "CONFSTECH", found: 1, error: null },
        { source: "MEETUP", found: 1, error: null },
      ],
    });
    expect(steps[0]).toBe("Looking for tech events near you and worldwide");
    expect(steps[1]).toMatch(/^Scoring 3 /);
    expect((await loadSettings()).eventsLastRefresh).toEqual(result);

    await refreshEventsJob.run({}, { step: async () => {}, signal: new AbortController().signal } as never);
  });
});
