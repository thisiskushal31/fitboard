import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { buildExport } from "@/lib/upkeep/data-export";
import { importExport, parseExport } from "@/lib/upkeep/data-import";
import { createTestClient, resetDatabase } from "@/test/db";

import { seedBuiltIns } from "../../../../../prisma/seed/built-ins";
import { seedDemo } from "../../../../../prisma/seed/demo";

import { deleteEverything } from "@/app/(app)/settings/actions";

const db = vi.hoisted(() => ({ client: undefined as ReturnType<typeof createTestClient> | undefined }));
vi.mock("@/lib/core/prisma", async () => {
  const { createTestClient } = await import("@/test/db");
  db.client = createTestClient();
  return { prisma: db.client };
});
vi.mock("@/lib/auth/session", () => ({
  getSession: async () => ({ persistent: false, issuedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
const redirected = vi.hoisted(() => ({ to: "" }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    redirected.to = to;
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: `NEXT_REDIRECT;replace;${to};307;` });
  },
  unstable_rethrow: (error: unknown) => {
    if ((error as { digest?: string }).digest?.startsWith("NEXT_REDIRECT")) throw error;
  },
}));
const dataDir = vi.hoisted(() => ({ path: "" }));
vi.mock("@/lib/core/env", () => ({ env: { get FITBOARD_DATA_DIR() { return dataDir.path; }, FITBOARD_SECRET: "s".repeat(32) } }));

const prisma = () => db.client!;
const now = new Date(2026, 8, 28, 12);
const snapshot = async () => JSON.stringify({ ...(await buildExport(prisma(), { now })), exportedAt: null });

beforeEach(async () => {
  dataDir.path = await mkdtemp(path.join(tmpdir(), "fitboard-delete-"));
  await mkdir(path.join(dataDir.path, "backups"));
  await writeFile(path.join(dataDir.path, "backups", "fitboard-backup-nightly-2026-09-27-030000.json"), "{}");
  redirected.to = "";
  await resetDatabase(prisma());
  await seedBuiltIns(prisma());
  await seedDemo(prisma(), { now });
  await prisma().theme.create({ data: { id: "mine", name: "Mine", headFont: "GEIST", bodyFont: "GEIST", accent: "#224466" } });
  await prisma().setting.create({ data: { key: "paper", value: "LETTER" } });
  await prisma().job.create({ data: { type: "refine", key: "refine:x", status: "DONE", input: {} } });
});
afterAll(async () => {
  await rm(dataDir.path, { recursive: true, force: true });
  await prisma().$disconnect();
});

describe("deleteEverything", () => {
  it("wipes all user data and the backups, keeps the built-in themes, and lands on the dashboard", async () => {
    // A saved posting from Find jobs goes too.
    await prisma().posting.create({ data: { source: "BOARDSEARCH", externalId: "job-1", savedAt: new Date() } });
    await prisma().postingSearch.create({ data: { source: "BOARDSEARCH", query: {}, postings: [] } });
    // And what the job agent found.
    await prisma().agentCandidate.create({ data: { source: "BOARDSEARCH", externalId: "job-1", dedupeKey: "key-1" } });
    await prisma().postingScore.create({ data: { source: "BOARDSEARCH", externalId: "job-1", score: 80, reasons: [], redFlags: [], scoredWith: "score-posting@1" } });
    // And Startups, with the fingerprints of ones removed for good.
    await prisma().startup.create({ data: { source: "HN", externalId: "1", company: "Acme", roles: [], emails: [], links: [], reasons: [] } });
    await prisma().startupBlock.create({ data: { hash: "a".repeat(64) } });
    // A posting pasted for Claude chat, and the connector, which goes off.
    await prisma().claudePaste.create({ data: { text: "A posting", expiresAt: new Date(Date.now() + 60_000) } });
    await prisma().setting.create({ data: { key: "connectorEnabledAt", value: "2026-10-23T09:00:00.000Z" } });
    await expect(deleteEverything({ confirm: "DELETE" })).rejects.toThrow("NEXT_REDIRECT");
    expect(redirected.to).toBe("/");
    const counts = await Promise.all([
      prisma().posting.count(),
      prisma().postingSearch.count(),
      prisma().agentCandidate.count(),
      prisma().postingScore.count(),
      prisma().startup.count(),
      prisma().startupBlock.count(),
      prisma().claudePaste.count(),
      prisma().application.count(),
      prisma().document.count(),
      prisma().skill.count(),
      prisma().experience.count(),
      prisma().project.count(),
      prisma().publication.count(),
      prisma().profileField.count(),
      prisma().setting.count(),
      prisma().job.count(),
      prisma().theme.count({ where: { builtIn: false } }),
    ]);
    expect(counts).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(await prisma().theme.count({ where: { builtIn: true } })).toBe(12);
    expect(await readdir(dataDir.path)).toEqual([]);
  });

  it("does nothing without DELETE typed exactly", async () => {
    expect(await deleteEverything({ confirm: "delete" as "DELETE" })).toMatchObject({ ok: false });
    expect(await prisma().application.count()).toBeGreaterThan(0);
  });

  it("comes back whole from an export (the epic's round trip)", async () => {
    const before = await snapshot();
    const file = parseExport(JSON.stringify(await buildExport(prisma(), { now })));
    await deleteEverything({ confirm: "DELETE" }).catch(() => {});
    expect(await prisma().application.count()).toBe(0);

    if (!file.ok) throw new Error(file.error);
    await importExport(prisma(), file.data);
    expect(await snapshot()).toBe(before);
  });
});
