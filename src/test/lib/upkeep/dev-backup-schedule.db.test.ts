import { mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { backupFileName, pruneDevBackups, writeBackup } from "@/lib/upkeep/backups";
import { isDevBackupEnabled, runDevBackup, startDevBackupSchedule } from "@/lib/upkeep/dev-backup-schedule";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/core/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
const dataDir = vi.hoisted(() => ({ path: "" }));
vi.mock("@/lib/core/env", () => ({
  env: { get FITBOARD_DATA_DIR() { return dataDir.path; }, FITBOARD_BACKUP_RETENTION_DAYS: 14, FITBOARD_SECRET: "s".repeat(32) },
}));
vi.mock("@/lib/core/log", () => ({ logServerError: vi.fn() }));

const prisma = () => db.client!;
const cwd = () => dataDir.path;
const devBackups = () => readdir(path.join(cwd(), "data", "backups")).catch(() => [] as string[]);

beforeEach(async () => {
  dataDir.path = await mkdtemp(path.join(tmpdir(), "fitboard-dev-backups-"));
  vi.spyOn(process, "cwd").mockReturnValue(dataDir.path);
  await resetDatabase(prisma());
  await prisma().application.create({ data: { company: "Ledgerly" } });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dataDir.path, { recursive: true, force: true }).catch(() => {});
});
afterAll(async () => {
  await prisma().$disconnect();
});

describe("dev backups", () => {
  it("name files with the dev reason", () => {
    expect(backupFileName("dev", new Date(2026, 8, 28, 15, 5, 0))).toBe("fitboard-backup-dev-2026-09-28-150500.json");
  });

  it("run only in development", () => {
    expect(isDevBackupEnabled("development")).toBe(true);
    expect(isDevBackupEnabled("production")).toBe(false);
    expect(isDevBackupEnabled("test")).toBe(false);
  });

  it("write an export under <cwd>/data/backups without deleting applications", async () => {
    const now = new Date(2026, 8, 28, 15, 5, 0);
    expect(await runDevBackup(now)).toBe("written");
    expect(await devBackups()).toEqual(["fitboard-backup-dev-2026-09-28-150500.json"]);
    expect(await prisma().application.count()).toBe(1);
  });

  it("writeBackup(dev) leaves FITBOARD_DATA_DIR backups alone", async () => {
    await writeBackup("nightly", new Date(2026, 8, 28, 3, 0));
    await runDevBackup(new Date(2026, 8, 28, 15, 5, 0));
    expect(await readdir(path.join(dataDir.path, "backups"))).toEqual(["fitboard-backup-nightly-2026-09-28-030000.json"]);
    expect(await devBackups()).toEqual(["fitboard-backup-dev-2026-09-28-150500.json"]);
  });

  it("remove only old fitboard-backup-dev files", async () => {
    const dir = path.join(cwd(), "data", "backups");
    await runDevBackup(new Date(2026, 8, 28, 15, 5));
    const old = path.join(dir, "fitboard-backup-dev-2026-09-27-120000.json");
    await writeFile(old, "{}");
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await utimes(old, twoDaysAgo, twoDaysAgo);
    expect(await pruneDevBackups(new Date())).toBe(1);
    expect(await devBackups()).toEqual(["fitboard-backup-dev-2026-09-28-150500.json"]);
  });

  it("startDevBackupSchedule does nothing outside development", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      startDevBackupSchedule();
    } finally {
      process.env.NODE_ENV = previous;
    }
  });
});
