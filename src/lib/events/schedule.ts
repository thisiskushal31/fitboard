import "server-only";

import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/core/log";
import type { SettingsData } from "@/lib/settings/settings";
import { loadSettings } from "@/lib/settings/settings-data";

import { EVENTS_JOB_KEY, startEventsRefresh } from "./refresh";

// Engagement → Events: hourly check for the daily refresh while the screen is in use.

const EVERY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long after the last open the daily refresh still runs. */
const IN_USE_MS = 14 * DAY_MS;
/** Minimum age of the last refresh before another daily run. */
const AGE_MS = 22 * 60 * 60 * 1000;

export function eventsRefreshDue(settings: Pick<SettingsData, "eventsViewedAt" | "eventsLastRefresh">, now: Date): boolean {
  const { eventsViewedAt: viewed, eventsLastRefresh: last } = settings;
  if (!viewed || !last) return false;
  return now.getTime() - Date.parse(viewed) < IN_USE_MS && now.getTime() - Date.parse(last.at) >= AGE_MS;
}

export async function startDueEventsRefresh(now = new Date()): Promise<string | null> {
  if (!eventsRefreshDue(await loadSettings(), now)) return null;
  if ((await findUnfinishedJobs(EVENTS_JOB_KEY)).length > 0) return null;
  return startEventsRefresh();
}

const globalForEvents = globalThis as unknown as { eventsTimer?: ReturnType<typeof setInterval> };

export function startEventsSchedule(): void {
  if (globalForEvents.eventsTimer) return;
  const check = () => void startDueEventsRefresh().catch((error: unknown) => logServerError("events schedule", error));
  globalForEvents.eventsTimer = setInterval(check, EVERY_MS);
  globalForEvents.eventsTimer.unref?.();
  check();
}
