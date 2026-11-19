import { describe, expect, it, vi } from "vitest";

import { refreshFreelance } from "@/lib/freelance/refresh";
import { SourceError } from "@/lib/freelance/sources/http";
import type { FoundFreelance } from "@/lib/freelance/types";

vi.mock("@/lib/core/log", () => ({ logServerError: vi.fn() }));
vi.mock("@/lib/settings/settings-data", () => ({ saveSettings: vi.fn(async () => {}) }));
vi.mock("@/lib/profile/profile-data", () => ({
  loadProfile: async () => ({ basics: { city: "Berlin", country: "Germany", headline: "", summary: "" }, skills: [], experience: [] }),
}));

const sources = vi.hoisted(() => ({
  hn: [] as FoundFreelance[],
  remotive: [] as FoundFreelance[],
  wwr: [] as FoundFreelance[],
  freelancer: [] as FoundFreelance[],
  remoteok: [] as FoundFreelance[],
  hnError: null as unknown,
  storeError: null as unknown,
}));

vi.mock("@/lib/freelance/sources/hn", () => ({
  fetchHnFreelance: async () => {
    if (sources.hnError) throw sources.hnError;
    return sources.hn;
  },
}));
vi.mock("@/lib/freelance/sources/remotive", () => ({ fetchRemotiveFreelance: async () => sources.remotive }));
vi.mock("@/lib/freelance/sources/wwr", () => ({ fetchWwrFreelance: async () => sources.wwr }));
vi.mock("@/lib/freelance/sources/freelancer", () => ({ fetchFreelancerFreelance: async () => sources.freelancer }));
vi.mock("@/lib/freelance/sources/remoteok", () => ({ fetchRemoteOkFreelance: async () => sources.remoteok }));
vi.mock("@/lib/freelance/store", () => ({
  upsertFreelance: async () => {
    if (sources.storeError) throw sources.storeError;
    return 2;
  },
  rescoreFreelance: async () => {},
  sweepFreelance: async () => ({ removed: 0 }),
}));

const sample: FoundFreelance = {
  source: "REMOTIVE",
  externalId: "1",
  title: "Contract React",
  company: "Acme",
  place: "Remote",
  remote: true,
  engagement: "CONTRACT",
  budget: "",
  duration: "",
  url: "https://example.com/1",
  description: "React",
  postedAt: null,
};

describe("refreshFreelance", () => {
  it("records SourceError, unexpected failures, abort, and store errors", async () => {
    sources.hn = [];
    sources.remotive = [sample];
    sources.wwr = [];
    sources.freelancer = [];
    sources.remoteok = [];
    sources.hnError = new SourceError("took too long to answer");
    sources.storeError = null;

    const ok = await refreshFreelance(async () => {}, new AbortController().signal, new Date("2026-11-19T12:00:00Z"));
    expect(ok.sources.find((entry) => entry.source === "HN")?.error).toMatch(/took too long/);
    expect(ok.added).toBe(2);

    sources.hnError = Object.assign(new Error("stopped"), { name: "AbortError" });
    const abortedSource = await refreshFreelance(async () => {}, new AbortController().signal, new Date("2026-11-19T12:00:00Z"));
    expect(abortedSource.sources.find((entry) => entry.source === "HN")?.error).toMatch(/was stopped/);

    const controller = new AbortController();
    controller.abort();
    await expect(refreshFreelance(async () => {}, controller.signal, new Date("2026-11-19T12:00:00Z"))).rejects.toMatchObject({ name: "AbortError" });

    sources.hnError = null;
    sources.storeError = new SourceError("couldn't save what it found");
    await expect(refreshFreelance(async () => {}, new AbortController().signal, new Date("2026-11-19T12:00:00Z"))).rejects.toMatchObject({
      name: "SourceError",
      message: "couldn't save what it found",
    });
  });
});
