import type { Metadata } from "next";

import { EVENTS_JOB_KEY } from "@/lib/events/refresh";
import { listEvents } from "@/lib/events/store";
import { eventFilterFromParams } from "@/lib/events/types";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { loadProfile } from "@/lib/profile/profile-data";
import { loadSettings, saveSettings } from "@/lib/settings/settings-data";
import { lastKnownTimeZone } from "@/lib/settings/time-zone";
import { placeOf } from "@/lib/startups/place";

import { EventsScreen } from "./events-screen";

export const metadata: Metadata = { title: "Events" };

const VIEW_MARK_MS = 60 * 60 * 1000;

/**
 * Tech events worldwide, ranked by how near they are to the profile place
 * and how well they fit the skills. Fitboard never registers for you.
 */
export default async function EventsPage({ searchParams }: PageProps<"/events">) {
  const filter = eventFilterFromParams(await searchParams);
  const [profile, settings, [running], timeZone] = await Promise.all([
    loadProfile(),
    loadSettings(),
    findUnfinishedJobs(EVENTS_JOB_KEY),
    lastKnownTimeZone(),
  ]);
  const place = placeOf(profile.basics);
  const now = new Date();
  if (!settings.eventsViewedAt || now.getTime() - Date.parse(settings.eventsViewedAt) > VIEW_MARK_MS) {
    await saveSettings({ eventsViewedAt: now.toISOString() });
  }
  return (
    <EventsScreen
      filter={filter}
      list={await listEvents(filter, place)}
      lastRefresh={settings.eventsLastRefresh}
      refreshJobId={running?.id ?? null}
      city={place.city}
      country={place.country ? place.countryName : ""}
      today={now.toISOString()}
      timeZone={timeZone}
    />
  );
}
