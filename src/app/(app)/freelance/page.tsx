import type { Metadata } from "next";

import { isAiConfigured } from "@/lib/ai/config";
import { FREELANCE_JOB_KEY } from "@/lib/freelance/refresh";
import { listFreelance } from "@/lib/freelance/store";
import { freelanceFilterFromParams } from "@/lib/freelance/types";
import { findUnfinishedJobs } from "@/lib/jobs/runner";
import { loadProfile } from "@/lib/profile/profile-data";
import { loadSettings, saveSettings } from "@/lib/settings/settings-data";
import { lastKnownTimeZone } from "@/lib/settings/time-zone";
import { placeOf } from "@/lib/startups/place";

import { FreelanceScreen } from "./freelance-screen";

export const metadata: Metadata = { title: "Freelance" };

const VIEW_MARK_MS = 60 * 60 * 1000;

/**
 * Contract, project, and temporary gigs from public sources, ranked against
 * the profile. Nothing is sent: you open the posting or start an application yourself.
 */
export default async function FreelancePage({ searchParams }: PageProps<"/freelance">) {
  const filter = freelanceFilterFromParams(await searchParams);
  const [profile, settings, aiReady, [running], timeZone] = await Promise.all([
    loadProfile(),
    loadSettings(),
    isAiConfigured(),
    findUnfinishedJobs(FREELANCE_JOB_KEY),
    lastKnownTimeZone(),
  ]);
  const place = placeOf(profile.basics);
  const now = new Date();
  if (!settings.freelanceViewedAt || now.getTime() - Date.parse(settings.freelanceViewedAt) > VIEW_MARK_MS) {
    await saveSettings({ freelanceViewedAt: now.toISOString() });
  }
  return (
    <FreelanceScreen
      filter={filter}
      list={await listFreelance(filter, place)}
      lastRefresh={settings.freelanceLastRefresh}
      refreshJobId={running?.id ?? null}
      city={place.city}
      country={place.country ? place.countryName : ""}
      aiReady={aiReady}
      today={now.toISOString()}
      timeZone={timeZone}
    />
  );
}
