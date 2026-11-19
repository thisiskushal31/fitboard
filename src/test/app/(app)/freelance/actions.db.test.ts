import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { refreshFreelanceNow, removeFreelanceForGood, saveFreelanceNotes, setFreelanceStatus } from "@/app/(app)/freelance/actions";

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
vi.mock("@/lib/core/log", () => ({ logServerError: vi.fn() }));
const start = vi.hoisted(() => vi.fn(async () => "freelance-job"));
vi.mock("@/lib/freelance/refresh", () => ({ startFreelanceRefresh: start }));

const prisma = () => db.client!;

async function seedGig() {
  return prisma().freelanceOpportunity.create({
    data: {
      source: "HN",
      externalId: "gig-1",
      title: "Contract Android",
      company: "Acme",
      place: "Berlin",
      remote: false,
      engagement: "CONTRACT",
      budget: "$80/hr",
      duration: "",
      url: "https://example.com/g1",
      description: "Android",
      score: 80,
      reasons: ["Android"],
      scoredWith: "freelance-match@1",
      status: "NEW",
      notes: "",
      seenAt: new Date(),
    },
  });
}

beforeEach(async () => {
  start.mockClear();
  await resetDatabase(prisma());
});
afterAll(() => prisma().$disconnect());

describe("Freelance actions", () => {
  it("starts a refresh job", async () => {
    expect(await refreshFreelanceNow({})).toEqual({ ok: true, data: { jobId: "freelance-job" } });
    expect(start).toHaveBeenCalledOnce();
  });

  it("saves status and notes, and removes for good", async () => {
    const row = await seedGig();
    expect(await setFreelanceStatus({ id: row.id, status: "SAVED" })).toEqual({ ok: true, data: { status: "SAVED" } });
    expect(await saveFreelanceNotes({ id: row.id, notes: "Pitch later" })).toEqual({ ok: true, data: null });
    expect(await prisma().freelanceOpportunity.findUnique({ where: { id: row.id } })).toMatchObject({ status: "SAVED", notes: "Pitch later" });

    expect(await removeFreelanceForGood({ id: row.id })).toMatchObject({ ok: true, toast: expect.stringMatching(/Removed/) });
    expect(await prisma().freelanceOpportunity.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await prisma().freelanceBlock.count()).toBeGreaterThan(0);
  });

  it("says when the opportunity is gone", async () => {
    expect(await setFreelanceStatus({ id: "missing", status: "SAVED" })).toMatchObject({ ok: false, error: expect.stringMatching(/no longer/i) });
    expect(await saveFreelanceNotes({ id: "missing", notes: "x" })).toMatchObject({ ok: false });
    expect(await removeFreelanceForGood({ id: "missing" })).toMatchObject({ ok: false });
  });
});
