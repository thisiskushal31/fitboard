// Next.js calls register() once when a server starts, before it handles any
// request. It doesn't run during `next build`, so the build needs no secrets.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { checkEnvOnStartup } = await import("@/lib/core/env");
    checkEnvOnStartup();

    // AI jobs left running by the previous process can't finish.
    const { recoverInterruptedJobs } = await import("@/lib/jobs/runner");
    const { logServerError } = await import("@/lib/core/log");
    await recoverInterruptedJobs().catch((error: unknown) => logServerError("startup", error));

    // Finished jobs, with what they were given and wrote, are deleted after a while.
    const { startJobSweep } = await import("@/lib/jobs/retention");
    startJobSweep();

    // Nightly backups at 03:00, while they're switched on.
    const { startBackupSchedule } = await import("@/lib/upkeep/backup-schedule");
    startBackupSchedule();

    // The inbox check, while a Google account is connected.
    const { startInboxSchedule } = await import("@/lib/google/sync");
    startInboxSchedule();

    // The job agent's daily run, while it's on.
    const { startAgentSchedule } = await import("@/lib/agent/schedule");
    startAgentSchedule();

    // Startups' daily refresh, once it was refreshed by hand and while the screen is in use.
    const { startStartupsSchedule } = await import("@/lib/startups/schedule");
    startStartupsSchedule();

    // FITBOARD_JOBS_SOURCE=arbeitsagentur: the log says what that choice means.
    const { arbeitsagenturStartupNotice, loadJobSearchConfig } = await import("@/lib/job-search/config");
    try {
      const notice = arbeitsagenturStartupNotice(await loadJobSearchConfig());
      if (notice) console.log(notice);
    } catch (error) {
      logServerError("job search", error);
    }

    // Usage ping temporarily disabled — uncomment to restore startup wiring.
    // FITBOARD_TELEMETRY, when set, is the usage ping's answer on record.
    // Then the log says what the ping sends while it's on, or how to answer
    // while nobody has.
    // const { recordEnvChoice, usagePingNotice } = await import("@/lib/upkeep/usage-ping");
    // const { loadSettings } = await import("@/lib/settings/settings-data");
    // try {
    //   await recordEnvChoice();
    //   const notice = usagePingNotice(await loadSettings());
    //   if (notice) console.log(notice);
    // } catch (error) {
    //   logServerError("usage ping", error);
    // }
  }
}
