import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { createTestClient, resetDatabase } from "@/test/db";

import { refreshEventsNow, removeEventForGood, saveEventNotes, setEventStatus } from "@/app/(app)/events/actions";

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
const start = vi.hoisted(() => vi.fn(async () => "events-job"));
vi.mock("@/lib/events/refresh", () => ({ startEventsRefresh: start }));

const prisma = () => db.client!;

async function seedEvent() {
  return prisma().eventOpportunity.create({
    data: {
      source: "TECHCONF",
      externalId: "evt-1",
      title: "Android Summit",
      summary: "Android",
      url: "https://example.com/e1",
      place: "Berlin",
      city: "Berlin",
      country: "de",
      remote: false,
      format: "IN_PERSON",
      startsAt: new Date("2026-12-01T00:00:00Z"),
      speakers: ["Ada"],
      score: 80,
      proximity: 0,
      reasons: ["In Berlin"],
      scoredWith: "events-match@1",
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

describe("Events actions", () => {
  it("starts a refresh job", async () => {
    expect(await refreshEventsNow({})).toEqual({ ok: true, data: { jobId: "events-job" } });
    expect(start).toHaveBeenCalledOnce();
  });

  it("saves status and notes, and removes for good", async () => {
    const row = await seedEvent();
    expect(await setEventStatus({ id: row.id, status: "SAVED" })).toEqual({ ok: true, data: { status: "SAVED" } });
    expect(await saveEventNotes({ id: row.id, notes: "Maybe go" })).toEqual({ ok: true, data: null });
    expect(await prisma().eventOpportunity.findUnique({ where: { id: row.id } })).toMatchObject({ status: "SAVED", notes: "Maybe go" });

    expect(await removeEventForGood({ id: row.id })).toMatchObject({ ok: true, toast: expect.stringMatching(/Removed/) });
    expect(await prisma().eventOpportunity.findUnique({ where: { id: row.id } })).toBeNull();
    expect(await prisma().eventBlock.count()).toBeGreaterThan(0);
  });

  it("says when the event is gone", async () => {
    expect(await setEventStatus({ id: "missing", status: "SAVED" })).toMatchObject({ ok: false, error: expect.stringMatching(/no longer/i) });
    expect(await saveEventNotes({ id: "missing", notes: "x" })).toMatchObject({ ok: false });
    expect(await removeEventForGood({ id: "missing" })).toMatchObject({ ok: false });
  });
});
