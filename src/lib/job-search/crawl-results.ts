import "server-only";

import { Prisma } from "@/generated/prisma/client";
import { logServerError } from "@/lib/core/log";
import { prisma } from "@/lib/core/prisma";

export type BoardCrawlStatus = "ok" | "empty" | "error";

export type BoardCrawlRecordInput = {
  url: string;
  company: string;
  status: BoardCrawlStatus;
  hitCount: number;
  samples: string[];
  detail: string;
  keywords: string;
  place: string;
  country: string;
  method: "browser" | "api" | "cache";
  durationMs: number;
  /**
   * When false, an empty/error outcome is auto-resolved (portal worked, or
   * catalog moved on). Open problems stay in Settings → Problems until fixed
   * or dismissed. Successful `ok` rows never need a manual resolve.
   */
  openProblem?: boolean;
};

/** Normalize catalog / stored careers URLs so trailing slashes still match. */
export function normalizeBoardCrawlUrl(url: string): string {
  try {
    const parsed = new URL(url.trim());
    parsed.hash = "";
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return url.trim().replace(/\/+$/, "");
  }
}

export type BoardCrawlResultView = {
  id: string;
  url: string;
  company: string;
  status: BoardCrawlStatus;
  hitCount: number;
  samples: string[];
  detail: string;
  keywords: string;
  place: string;
  country: string;
  method: string;
  durationMs: number;
  crawledAt: string;
  resolvedAt: string | null;
};

function asSamples(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").slice(0, 5);
}

function toView(row: {
  id: string;
  url: string;
  company: string;
  status: string;
  hitCount: number;
  samples: unknown;
  detail: string;
  keywords: string;
  place: string;
  country: string;
  method: string;
  durationMs: number;
  crawledAt: Date;
  resolvedAt: Date | null;
}): BoardCrawlResultView {
  const status: BoardCrawlStatus = row.status === "ok" || row.status === "empty" || row.status === "error" ? row.status : "error";
  return {
    id: row.id,
    url: row.url,
    company: row.company,
    status,
    hitCount: row.hitCount,
    samples: asSamples(row.samples),
    detail: row.detail,
    keywords: row.keywords,
    place: row.place,
    country: row.country,
    method: row.method,
    durationMs: row.durationMs,
    crawledAt: row.crawledAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  };
}

/**
 * Upsert the latest crawl outcome for one catalog URL. Failures here must not
 * break Find jobs / the agent.
 *
 * Status drives the Settings filters automatically:
 * - `ok` → With hits (no manual resolve)
 * - empty/error with `openProblem: false` → Resolved (auto)
 * - empty/error with an open problem → Problems
 */
export async function recordBoardCrawl(input: BoardCrawlRecordInput): Promise<void> {
  try {
    const url = input.url.slice(0, 2000);
    if (!url) return;
    const now = new Date();
    // ok → With hits. Soft empty (openProblem: false) → Resolved automatically.
    // Hard empty/error → Problems until the user dismisses or a later crawl fixes it.
    const resolvedAt = input.status === "ok" ? null : input.openProblem === false ? now : null;
    await prisma.boardCrawlResult.upsert({
      where: { url },
      create: {
        url,
        company: input.company.slice(0, 300),
        status: input.status,
        hitCount: Math.max(0, input.hitCount),
        samples: input.samples.slice(0, 5),
        detail: input.detail.slice(0, 2000),
        keywords: input.keywords.slice(0, 500),
        place: input.place.slice(0, 300),
        country: input.country.slice(0, 32),
        method: input.method,
        durationMs: Math.max(0, input.durationMs),
        crawledAt: now,
        resolvedAt,
      },
      update: {
        company: input.company.slice(0, 300),
        status: input.status,
        hitCount: Math.max(0, input.hitCount),
        samples: input.samples.slice(0, 5),
        detail: input.detail.slice(0, 2000),
        keywords: input.keywords.slice(0, 500),
        place: input.place.slice(0, 300),
        country: input.country.slice(0, 32),
        method: input.method,
        durationMs: Math.max(0, input.durationMs),
        crawledAt: now,
        resolvedAt,
      },
    });
  } catch (error) {
    // Diagnostics must never fail the search, but we need to see why Settings stays empty.
    logServerError("recordBoardCrawl", error);
  }
}

/**
 * Drop diagnostics for careers URLs that are no longer in the catalog
 * (replaced or removed rows in job-boards.json).
 */
export async function syncBoardCrawlWithCatalog(catalogUrls: readonly string[]): Promise<number> {
  try {
    const keep = new Set(catalogUrls.map((url) => normalizeBoardCrawlUrl(url)).filter(Boolean));
    if (keep.size === 0) return 0;
    const rows = await prisma.boardCrawlResult.findMany({ select: { id: true, url: true } });
    const staleIds = rows.filter((row) => !keep.has(normalizeBoardCrawlUrl(row.url))).map((row) => row.id);
    if (staleIds.length === 0) return 0;
    const result = await prisma.boardCrawlResult.deleteMany({ where: { id: { in: staleIds } } });
    return result.count;
  } catch (error) {
    logServerError("syncBoardCrawlWithCatalog", error);
    return 0;
  }
}

export type BoardCrawlListFilter = "problems" | "ok" | "all" | "resolved";

/** Rows for Settings → Board crawl. No artificial cap — one row per catalog URL. */
export async function listBoardCrawlResults(filter: BoardCrawlListFilter = "problems"): Promise<BoardCrawlResultView[]> {
  const where: Prisma.BoardCrawlResultWhereInput =
    filter === "problems"
      ? { resolvedAt: null, status: { in: ["empty", "error"] } }
      : filter === "ok"
        ? { status: "ok" }
        : filter === "resolved"
          ? { resolvedAt: { not: null } }
          : {};
  const rows = await prisma.boardCrawlResult.findMany({
    where,
    orderBy: [{ crawledAt: "desc" }, { company: "asc" }],
  });
  return rows.map(toView);
}

export async function countBoardCrawlResults(): Promise<number> {
  return prisma.boardCrawlResult.count();
}

export async function countBoardCrawlProblems(): Promise<number> {
  return prisma.boardCrawlResult.count({ where: { resolvedAt: null, status: { in: ["empty", "error"] } } });
}

export async function markBoardCrawlResolved(id: string): Promise<void> {
  await prisma.boardCrawlResult.update({ where: { id }, data: { resolvedAt: new Date() } });
}

export async function deleteBoardCrawlResult(id: string): Promise<void> {
  await prisma.boardCrawlResult.delete({ where: { id } });
}

export async function clearResolvedBoardCrawls(): Promise<number> {
  const result = await prisma.boardCrawlResult.deleteMany({ where: { resolvedAt: { not: null } } });
  return result.count;
}

export async function clearAllBoardCrawls(): Promise<number> {
  const result = await prisma.boardCrawlResult.deleteMany();
  return result.count;
}
