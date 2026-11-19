import "server-only";

import { z } from "zod";

import { defineJob, findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/core/log";
import { loadProfile } from "@/lib/profile/profile-data";
import { saveSettings } from "@/lib/settings/settings-data";
import { placeOf } from "@/lib/startups/place";

import { SourceError } from "./sources/http";
import { fetchFreelancerFreelance } from "./sources/freelancer";
import { fetchHnFreelance } from "./sources/hn";
import { fetchRemoteOkFreelance } from "./sources/remoteok";
import { fetchRemotiveFreelance } from "./sources/remotive";
import { fetchWwrFreelance } from "./sources/wwr";
import { rescoreFreelance, sweepFreelance, upsertFreelance } from "./store";
import { FREELANCE_SOURCE_INFO, freelanceRefreshSchema, type FoundFreelance, type FreelanceRefresh, type FreelanceSource } from "./types";

// Engagement → Freelance refresh: asks each public source, stores what they
// found, scores it, and records the outcome for the screen.

export const FREELANCE_JOB_KEY = "freelance-refresh";

function sourceFailure(source: FreelanceSource, reason: unknown): string {
  if (reason instanceof SourceError) return `${FREELANCE_SOURCE_INFO[source].name} ${reason.message}`;
  if (reason instanceof Error && reason.name === "AbortError") return `${FREELANCE_SOURCE_INFO[source].name} was stopped`;
  return `${FREELANCE_SOURCE_INFO[source].name} failed`;
}

export async function refreshFreelance(
  step: (name: string) => Promise<void> = async () => {},
  signal: AbortSignal = new AbortController().signal,
  now = new Date(),
): Promise<FreelanceRefresh> {
  const place = placeOf((await loadProfile()).basics);
  const sources: { source: FreelanceSource; fetch: () => Promise<FoundFreelance[]> }[] = [
    { source: "HN", fetch: () => fetchHnFreelance(place, signal) },
    { source: "REMOTIVE", fetch: () => fetchRemotiveFreelance(signal) },
    { source: "WWR", fetch: () => fetchWwrFreelance(signal) },
    { source: "FREELANCER", fetch: () => fetchFreelancerFreelance(signal) },
    { source: "REMOTEOK", fetch: () => fetchRemoteOkFreelance(signal) },
  ];

  await step("Looking for freelance and contract gigs");
  const results = await Promise.allSettled(sources.map((entry) => entry.fetch()));
  signal.throwIfAborted();
  const outcomes = results.map((result, index) => {
    const { source } = sources[index];
    if (result.status === "fulfilled") return { source, found: result.value.length, error: null };
    if (!(result.reason instanceof SourceError)) logServerError(`freelance: ${source}`, result.reason);
    return { source, found: 0, error: sourceFailure(source, result.reason) };
  });
  const found = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

  await step(`Scoring ${found.length} ${found.length === 1 ? "opportunity" : "opportunities"} against your profile`);
  try {
    const added = await upsertFreelance(found, now);
    await rescoreFreelance(now);
    await sweepFreelance(now);
    const result: FreelanceRefresh = { at: now.toISOString(), added, sources: outcomes };
    await saveSettings({ freelanceLastRefresh: result });
    return result;
  } catch (error) {
    logServerError("freelance: store", error);
    throw error instanceof SourceError ? error : new SourceError("couldn't save what it found");
  }
}

export const refreshFreelanceJob = defineJob({
  type: "freelance-refresh",
  input: z.object({}),
  result: freelanceRefreshSchema,
  run: (_input, { step, signal }) => refreshFreelance(step, signal),
});

export async function startFreelanceRefresh(): Promise<string> {
  const [running] = await findUnfinishedJobs(FREELANCE_JOB_KEY);
  return running?.id ?? startJob(refreshFreelanceJob, {}, { key: FREELANCE_JOB_KEY });
}
