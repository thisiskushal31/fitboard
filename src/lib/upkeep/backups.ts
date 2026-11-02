import "server-only";

import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildExport } from "@/lib/upkeep/data-export";
import { env } from "@/lib/core/env";
import { prisma } from "@/lib/core/prisma";

// Backups: exports written to FITBOARD_DATA_DIR/backups. They
// never hold the API key in plain text.

export type BackupReason = "before-import" | "nightly";

export const backupsDir = () => path.join(env.FITBOARD_DATA_DIR, "backups");

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
  await mkdir(backupsDir(), { recursive: true });
  const name = backupFileName(reason, now);
  await writeFile(path.join(backupsDir(), name), JSON.stringify(data, null, 2));
  return name;
}

/** The backup files, newest first. */
export async function listBackups(): Promise<{ name: string; modified: Date }[]> {
  const names = (await readdir(backupsDir()).catch(() => [])).filter((name) => /^fitboard-backup-.*\.json$/.test(name));
  const files = await Promise.all(names.map(async (name) => ({ name, modified: (await stat(path.join(backupsDir(), name))).mtime })));
  return files.sort((a, b) => b.modified.getTime() - a.modified.getTime());
}

/** Deletes every backup file (Delete everything,). */
export async function deleteAllBackups(): Promise<void> {
  await rm(backupsDir(), { recursive: true, force: true });
}
