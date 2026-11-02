import { beforeEach, describe, expect, it, vi } from "vitest";

import { prisma } from "@/lib/core/prisma";
import { appVersion } from "@/lib/upkeep/version";

import { GET } from "@/app/api/health/route";

vi.mock("@/lib/core/prisma", () => ({ prisma: { $queryRaw: vi.fn() } }));

describe("GET /api/health", () => {
  beforeEach(() => vi.useRealTimers());

  it("answers 200 with the version when the database answers", async () => {
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ "?column?": 1 }] as never);
    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ status: "ok", version: appVersion, db: "ok" });
  });

  it("answers 503 when the database fails", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValue(new Error("connection refused") as never);
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable", version: appVersion, db: "unreachable" });
  });

  it("answers 503 when the database doesn't answer in time", async () => {
    vi.useFakeTimers();
    vi.mocked(prisma.$queryRaw).mockReturnValue(new Promise(() => {}) as never);
    const pending = GET();
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await pending).status).toBe(503);
  });
});
