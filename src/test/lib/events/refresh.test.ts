import { describe, expect, it, vi } from "vitest";

import { refreshEvents } from "@/lib/events/refresh";
import { SourceError } from "@/lib/events/sources/http";
import type { FoundEvent } from "@/lib/events/types";

vi.mock("@/lib/core/log", () => ({ logServerError: vi.fn() }));
vi.mock("@/lib/settings/settings-data", () => ({ saveSettings: vi.fn(async () => {}) }));

const sources = vi.hoisted(() => ({
  techconf: [] as FoundEvent[],
  techmeetups: [] as FoundEvent[],
  confstech: [] as FoundEvent[],
  meetup: [] as FoundEvent[],
  techconfError: null as unknown,
  storeError: null as unknown,
}));

vi.mock("@/lib/events/sources/techconf", () => ({
  fetchTechConfEvents: async () => {
    if (sources.techconfError) throw sources.techconfError;
    return sources.techconf;
  },
}));
vi.mock("@/lib/events/sources/techmeetups", () => ({ fetchTechMeetupsEvents: async () => sources.techmeetups }));
vi.mock("@/lib/events/sources/confstech", () => ({ fetchConfsTechEvents: async () => sources.confstech }));
vi.mock("@/lib/events/sources/meetup", () => ({ fetchMeetupEvents: async () => sources.meetup }));
vi.mock("@/lib/events/sources/company", () => ({ fetchCompanyEvents: async () => [] }));
vi.mock("@/lib/events/store", () => ({
  upsertEvents: async () => {
    if (sources.storeError) throw sources.storeError;
    return 1;
  },
  rescoreEvents: async () => {},
  sweepEvents: async () => ({ removed: 0 }),
}));
vi.mock("@/lib/events/place-learn", () => ({
  enrichEventPlaces: async (events: FoundEvent[]) => events,
}));

const sample: FoundEvent = {
  source: "TECHMEETUPS",
  externalId: "1",
  title: "AI Summit",
  summary: "",
  url: "https://example.com/1",
  place: "Berlin",
  city: "Berlin",
  country: "de",
  remote: false,
  format: "IN_PERSON",
  startsAt: "2026-12-01T00:00:00.000Z",
  endsAt: null,
  ticketPrice: "",
  speakers: [],
  attendance: null,
  audience: "",
};

describe("refreshEvents", () => {
  it("records SourceError, unexpected failures, and abort after fetches", async () => {
    sources.techconf = [];
    sources.techmeetups = [sample];
    sources.confstech = [];
    sources.meetup = [];
    sources.techconfError = new SourceError("took too long to answer");
    sources.storeError = null;

    const ok = await refreshEvents(async () => {}, new AbortController().signal, new Date("2026-11-19T12:00:00Z"));
    expect(ok.sources.find((entry) => entry.source === "TECHCONF")?.error).toMatch(/took too long/);
    expect(ok.added).toBe(1);

    sources.techconfError = new Error("boom");
    const weird = await refreshEvents(async () => {}, new AbortController().signal, new Date("2026-11-19T12:00:00Z"));
    expect(weird.sources.find((entry) => entry.source === "TECHCONF")?.error).toMatch(/failed$/);

    const controller = new AbortController();
    controller.abort();
    await expect(refreshEvents(async () => {}, controller.signal, new Date("2026-11-19T12:00:00Z"))).rejects.toMatchObject({ name: "AbortError" });

    sources.techconfError = null;
    sources.storeError = new Error("db down");
    await expect(refreshEvents(async () => {}, new AbortController().signal, new Date("2026-11-19T12:00:00Z"))).rejects.toMatchObject({
      name: "SourceError",
      message: "couldn't save what it found",
    });
  });
});
