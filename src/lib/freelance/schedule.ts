import "server-only";

import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/core/log";
import type { SettingsData } from "@/lib/settings/settings";
import { loadSettings } from "@/lib/settings/settings-data";

import { FREELANCE_JOB_KEY, startFreelanceRefresh } from "./refresh";

// Engagement → Freelance: hourly check for the daily refresh while the screen is in use.

const EVERY_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long after the last open the daily refresh still runs. */
const IN_USE_MS = 14 * DAY_MS;
/** Minimum age of the last refresh before another daily run. */
const AGE_MS = 22 * 60 * 60 * 1000;

export function freelanceRefreshDue(settings: Pick<SettingsData, "freelanceViewedAt" | "freelanceLastRefresh">, now: Date): boolean {
  const { freelanceViewedAt: viewed, freelanceLastRefresh: last } = settings;
  if (!viewed || !last) return false;
  return now.getTime() - Date.parse(viewed) < IN_USE_MS && now.getTime() - Date.parse(last.at) >= AGE_MS;
}

export async function startDueFreelanceRefresh(now = new Date()): Promise<string | null> {
  if (!freelanceRefreshDue(await loadSettings(), now)) return null;
  if ((await findUnfinishedJobs(FREELANCE_JOB_KEY)).length > 0) return null;
  return startFreelanceRefresh();
}

const globalForFreelance = globalThis as unknown as { freelanceTimer?: ReturnType<typeof setInterval> };

export function startFreelanceSchedule(): void {
  if (globalForFreelance.freelanceTimer) return;
  const check = () => void startDueFreelanceRefresh().catch((error: unknown) => logServerError("freelance schedule", error));
  globalForFreelance.freelanceTimer = setInterval(check, EVERY_MS);
  globalForFreelance.freelanceTimer.unref?.();
  check();
}
