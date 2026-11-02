import type { Metadata } from "next";
import { Suspense } from "react";

import { periodFromParam } from "@/lib/dashboard/dashboard";
import { waitingByApplication } from "@/lib/google/inbox-data";
import { loadDashboard } from "@/lib/dashboard/dashboard-data";
import { dayPeriod, hourIn } from "@/lib/dashboard/greeting";
import { loadProfileName } from "@/lib/profile/profile-data";
import { loadSettings } from "@/lib/settings/settings-data";
import { userTimeZone } from "@/lib/settings/time-zone";

import { Dashboard } from "./dashboard";
import { CalendarSkeleton, DashboardCalendar } from "./dashboard-calendar";

export const metadata: Metadata = { title: "Dashboard" };

/**
 * The search as it stands now. Loaded again on every visit, so a status
 * change shows up immediately. `?period=` picks the time filter,
 * else the one last used. Interview times show in the browser's time
 * zone. `?date=` picks the calendar's month, which streams in
 * after the rest, as it waits on Google.
 */
export default async function DashboardPage({ searchParams }: PageProps<"/">) {
  const [{ period: param, date }, settings, timeZone] = await Promise.all([searchParams, loadSettings(), userTimeZone()]);
  const now = new Date();
  const range = periodFromParam(param) ?? settings.dashboardPeriod;
  const replies = await waitingByApplication().catch(() => undefined);
  const [figures, name] = await Promise.all([
    loadDashboard({ period: range, quietDays: settings.quietDays, timeZone, replies }),
    loadProfileName(),
  ]);
  return (
    <Dashboard
      figures={figures}
      firstName={name.trim().split(/\s+/)[0] ?? ""}
      period={dayPeriod(hourIn(timeZone))}
      range={range}
      quietDays={settings.quietDays}
      empty={figures.total === 0}
      calendar={
        <Suspense fallback={<CalendarSkeleton />}>
          <DashboardCalendar date={date} now={now} />
        </Suspense>
      }
    />
  );
}
