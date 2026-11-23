import "server-only";

import { pruneDevBackups, writeBackup } from "@/lib/upkeep/backups";
import { logServerError } from "@/lib/core/log";

// Development interval backups: while NODE_ENV is development, an export
// is written on startup and every hour to <cwd>/data/backups, and files
// older than 24 hours are removed. Read-only against the database.
// A plain timer in this process, so it's only safe with a single instance.

export const DEV_BACKUP_INTERVAL_MS = 60 * 60 * 1000;

const globalForSchedule = globalThis as unknown as { devBackupTimer?: ReturnType<typeof setInterval> };

/** Whether the development interval should run. */
export function isDevBackupEnabled(nodeEnv = process.env.NODE_ENV): boolean {
  return nodeEnv === "development";
}

/**
 * One interval run: write a `dev` backup, then prune old ones.
 * Failures are logged only — never thrown into startup, never wipe data.
 */
export async function runDevBackup(now = new Date()): Promise<"written"> {
  await writeBackup("dev", now);
  await pruneDevBackups(now);
  return "written";
}

/** Starts the development interval, once per process (dev reloads keep the one they have). */
export function startDevBackupSchedule(): void {
  if (!isDevBackupEnabled()) return;
  if (globalForSchedule.devBackupTimer) return;

  const tick = () => {
    void runDevBackup().catch((error: unknown) => logServerError("dev backup", error));
  };

  tick();
  globalForSchedule.devBackupTimer = setInterval(tick, DEV_BACKUP_INTERVAL_MS);
  globalForSchedule.devBackupTimer.unref?.();
}
