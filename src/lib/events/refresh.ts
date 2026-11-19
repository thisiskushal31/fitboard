import "server-only";

import { z } from "zod";

import { defineJob, findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/core/log";
import { saveSettings } from "@/lib/settings/settings-data";

import { SourceError } from "./sources/http";
import { fetchConfsTechEvents } from "./sources/confstech";
import { fetchMeetupEvents } from "./sources/meetup";
import { fetchTechConfEvents } from "./sources/techconf";
import { fetchTechMeetupsEvents } from "./sources/techmeetups";
import { rescoreEvents, sweepEvents, upsertEvents } from "./store";
import { EVENT_SOURCE_INFO, eventsRefreshSchema, type EventsRefresh, type EventSource, type FoundEvent } from "./types";

// Engagement → Events refresh: asks each public source, stores what they
// found, scores it, and records the outcome for the screen.

export const EVENTS_JOB_KEY = "events-refresh";

function sourceFailure(source: EventSource, reason: unknown): string {
  if (reason instanceof SourceError) return `${EVENT_SOURCE_INFO[source].name} ${reason.message}`;
  if (reason instanceof Error && reason.name === "AbortError") return `${EVENT_SOURCE_INFO[source].name} was stopped`;
  return `${EVENT_SOURCE_INFO[source].name} failed`;
}

export async function refreshEvents(
  step: (name: string) => Promise<void> = async () => {},
  signal: AbortSignal = new AbortController().signal,
  now = new Date(),
): Promise<EventsRefresh> {
  const sources: { source: EventSource; fetch: () => Promise<FoundEvent[]> }[] = [
    { source: "TECHCONF", fetch: () => fetchTechConfEvents(signal, now) },
    { source: "TECHMEETUPS", fetch: () => fetchTechMeetupsEvents(signal, now) },
    { source: "CONFSTECH", fetch: () => fetchConfsTechEvents(signal, now) },
    { source: "MEETUP", fetch: () => fetchMeetupEvents(signal, now) },
  ];

  await step("Looking for tech events near you and worldwide");
  const results = await Promise.allSettled(sources.map((entry) => entry.fetch()));
  signal.throwIfAborted();
  const outcomes = results.map((result, index) => {
    const { source } = sources[index];
    if (result.status === "fulfilled") return { source, found: result.value.length, error: null };
    if (!(result.reason instanceof SourceError)) logServerError(`events: ${source}`, result.reason);
    return { source, found: 0, error: sourceFailure(source, result.reason) };
  });
  const found = results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

  await step(`Scoring ${found.length} ${found.length === 1 ? "event" : "events"} against your profile and place`);
  try {
    const added = await upsertEvents(found, now);
    await rescoreEvents(now);
    await sweepEvents(now);
    const result: EventsRefresh = { at: now.toISOString(), added, sources: outcomes };
    await saveSettings({ eventsLastRefresh: result });
    return result;
  } catch (error) {
    logServerError("events: store", error);
    throw error instanceof SourceError ? error : new SourceError("couldn't save what it found");
  }
}

export const refreshEventsJob = defineJob({
  type: "events-refresh",
  input: z.object({}),
  result: eventsRefreshSchema,
  run: (_input, { step, signal }) => refreshEvents(step, signal),
});

export async function startEventsRefresh(): Promise<string> {
  const [running] = await findUnfinishedJobs(EVENTS_JOB_KEY);
  return running?.id ?? startJob(refreshEventsJob, {}, { key: EVENTS_JOB_KEY });
}
