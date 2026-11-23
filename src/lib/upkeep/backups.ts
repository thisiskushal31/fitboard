import "server-only";

import { mkdir, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildExport } from "@/lib/upkeep/data-export";
import { env } from "@/lib/core/env";
import { prisma } from "@/lib/core/prisma";

// Backups: exports under FITBOARD_DATA_DIR/backups (nightly, before-import)
// or <cwd>/data/backups (development interval). Never hold the API key in plain text.

export type BackupReason = "before-import" | "nightly" | "dev";

/** Nightly and before-import backups. */
export const backupsDir = () => path.join(env.FITBOARD_DATA_DIR, "backups");

/** Development interval backups: `<cwd>/data/backups`. */
export const devBackupsDir = (cwd = process.cwd()) => path.join(cwd, "data", "backups");

/** Folder for this backup reason. */
export function backupsDirFor(reason: BackupReason, cwd = process.cwd()): string {
  return reason === "dev" ? devBackupsDir(cwd) : backupsDir();
}

const pad = (value: number) => String(value).padStart(2, "0");

/** "fitboard-backup-nightly-2026-09-28-030000.json", in the server's time zone. */
export function backupFileName(reason: BackupReason, now: Date): string {
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `fitboard-backup-${reason}-${day}-${time}.json`;
}

/** Writes an export of everything to the backups folder; returns the file's name. */
export async function writeBackup(reason: BackupReason, now = new Date()): Promise<string> {
  const data = await buildExport(prisma, { now });
  const dir = backupsDirFor(reason);
  await mkdir(dir, { recursive: true });
  const name = backupFileName(reason, now);
  await writeFile(path.join(dir, name), JSON.stringify(data, null, 2));
  return name;
}

/** The backup files in a folder, newest first. */
export async function listBackupsIn(dir: string): Promise<{ name: string; modified: Date }[]> {
  const names = (await readdir(dir).catch(() => [])).filter((name) => /^fitboard-backup-.*\.json$/.test(name));
  const files = await Promise.all(names.map(async (name) => ({ name, modified: (await stat(path.join(dir, name))).mtime })));
  return files.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** The backup files under FITBOARD_DATA_DIR/backups, newest first. */
export async function listBackups(): Promise<{ name: string; modified: Date }[]> {
  return listBackupsIn(backupsDir());
}

/** Development interval backups under `<cwd>/data/backups`, newest first. */
export async function listDevBackups(cwd = process.cwd()): Promise<{ name: string; modified: Date }[]> {
  return listBackupsIn(devBackupsDir(cwd));
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Deletes `fitboard-backup-dev-*` files older than `maxAgeMs` (default 24h). */
export async function pruneDevBackups(
  now = new Date(),
  maxAgeMs = DAY_MS,
  cwd = process.cwd(),
): Promise<number> {
  const dir = devBackupsDir(cwd);
  const cutoff = now.getTime() - maxAgeMs;
  const old = (await listDevBackups(cwd)).filter(
    (backup) => backup.name.startsWith("fitboard-backup-dev-") && backup.modified.getTime() < cutoff,
  );
  await Promise.all(old.map((backup) => unlink(path.join(dir, backup.name)).catch(() => {})));
  return old.length;
}

/** Deletes every backup file under FITBOARD_DATA_DIR/backups (Delete everything). */
export async function deleteAllBackups(): Promise<void> {
  await rm(backupsDir(), { recursive: true, force: true });
}
