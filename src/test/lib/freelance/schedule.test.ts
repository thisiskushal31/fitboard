import { afterEach, describe, expect, it, vi } from "vitest";

import { freelanceRefreshDue, startDueFreelanceRefresh, startFreelanceSchedule } from "@/lib/freelance/schedule";

const state = vi.hoisted(() => ({
  settings: { freelanceViewedAt: null as string | null, freelanceLastRefresh: null as { at: string } | null },
  unfinished: [] as { id: string }[],
}));
vi.mock("@/lib/settings/settings-data", () => ({ loadSettings: async () => state.settings }));
vi.mock("@/lib/jobs/runner", () => ({ findUnfinishedJobs: async () => state.unfinished }));
vi.mock("@/lib/core/log", () => ({ logServerError: vi.fn() }));
const start = vi.hoisted(() => vi.fn(async () => "job-1"));
vi.mock("@/lib/freelance/refresh", () => ({ FREELANCE_JOB_KEY: "freelance-refresh", startFreelanceRefresh: start }));

afterEach(() => {
  start.mockClear();
  state.unfinished = [];
});

const now = new Date("2026-11-19T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000).toISOString();
const refresh = (at: string) => ({ at, added: 0, sources: [] });

describe("Freelance's daily refresh", () => {
  it("waits for the first refresh by hand, and runs daily while the screen is in use", () => {
    expect(freelanceRefreshDue({ freelanceViewedAt: hoursAgo(1), freelanceLastRefresh: null }, now)).toBe(false);
    expect(freelanceRefreshDue({ freelanceViewedAt: null, freelanceLastRefresh: refresh(hoursAgo(30)) }, now)).toBe(false);
    expect(freelanceRefreshDue({ freelanceViewedAt: hoursAgo(1), freelanceLastRefresh: refresh(hoursAgo(21)) }, now)).toBe(false);
    expect(freelanceRefreshDue({ freelanceViewedAt: hoursAgo(1), freelanceLastRefresh: refresh(hoursAgo(22)) }, now)).toBe(true);
    expect(freelanceRefreshDue({ freelanceViewedAt: hoursAgo(15 * 24), freelanceLastRefresh: refresh(hoursAgo(30)) }, now)).toBe(false);
  });

  it("starts the refresh when due, unless one is under way", async () => {
    state.settings = { freelanceViewedAt: hoursAgo(1), freelanceLastRefresh: refresh(hoursAgo(23)) };
    expect(await startDueFreelanceRefresh(now)).toBe("job-1");
    state.unfinished = [{ id: "running" }];
    expect(await startDueFreelanceRefresh(now)).toBeNull();
    state.settings = { freelanceViewedAt: null, freelanceLastRefresh: null };
    expect(await startDueFreelanceRefresh(now)).toBeNull();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("starts one timer per process", () => {
    const timer = vi.spyOn(globalThis, "setInterval");
    startFreelanceSchedule();
    startFreelanceSchedule();
    expect(timer).toHaveBeenCalledTimes(1);
    timer.mockRestore();
  });
});
