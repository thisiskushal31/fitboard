import { beforeEach, describe, expect, it, vi } from "vitest";

type LayoffRow = {
  company: string;
  normalizedCompany: string;
  laidOff: number | null;
  percentage: number | null;
  date: Date | null;
  location: string;
  country: string;
  industry: string;
  sourceUrl: string;
  rawNote: string;
};

type PrismaStub = {
  companyLayoff: {
    deleteMany: () => Promise<{ count: number }>;
    createMany: (args: { data: LayoffRow[] }) => Promise<{ count: number }>;
    findMany: (args: {
      where: { normalizedCompany?: string | { contains: string }; OR?: unknown[] };
      orderBy?: { date?: "desc" | "asc" }[];
    }) => Promise<LayoffRow[]>;
    count: () => Promise<number>;
  };
  $transaction: (work: (tx: PrismaStub) => Promise<unknown>) => Promise<unknown>;
};

const store = vi.hoisted(() => {
  const rows: LayoffRow[] = [];
  const prisma: PrismaStub = {
    companyLayoff: {
      deleteMany: async () => {
        rows.length = 0;
        return { count: 0 };
      },
      createMany: async ({ data }) => {
        rows.push(...data);
        return { count: data.length };
      },
      findMany: async ({ where, orderBy }) => {
        let filtered = rows;
        if (typeof where.normalizedCompany === "string") {
          filtered = filtered.filter((row) => row.normalizedCompany === where.normalizedCompany);
        } else {
          const needle = typeof where.normalizedCompany === "object" ? where.normalizedCompany.contains : "";
          filtered = filtered.filter((row) => !needle || row.normalizedCompany.includes(needle) || needle.includes(row.normalizedCompany));
        }
        if (orderBy?.[0]?.date === "desc") {
          filtered = [...filtered].sort((a, b) => (b.date?.getTime() ?? 0) - (a.date?.getTime() ?? 0));
        }
        return filtered;
      },
      count: async () => rows.length,
    },
    $transaction: async (work) => work(prisma),
  };
  return { rows, prisma };
});

vi.mock("@/lib/core/prisma", () => ({ prisma: store.prisma }));
vi.mock("@/lib/core/env", () => ({ env: { FITBOARD_LAYOFFS_URL: undefined } }));
vi.mock("@/lib/core/log", () => ({ logServerError: vi.fn() }));

describe("layoffs", () => {
  beforeEach(() => {
    store.rows.length = 0;
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("normalizes company names without company-specific aliases", async () => {
    const { normalizeCompanyName } = await import("@/lib/job-search/layoffs");
    expect(normalizeCompanyName("HSBC Holdings plc")).toBe("hsbc");
    expect(normalizeCompanyName("Acme, Inc.")).toBe("acme");
    expect(normalizeCompanyName("Foo & Bar GmbH")).toBe("foo and bar");
  });

  it("imports CSV rows newest-first and matches by normalized name", async () => {
    const { syncLayoffsFromCsv, layoffsForCompany } = await import("@/lib/job-search/layoffs");
    const csv = [
      "company,location,industry,total_laid_off,percentage_laid_off,date,stage,country,funds_raised_millions",
      "HSBC Holdings,London,Finance,200,0.01,1/10/2023,Post-IPO,United Kingdom,0",
      "HSBC Holdings,London,Finance,1000,0.05,1/15/2024,Post-IPO,United Kingdom,0",
      "Other Co,Berlin,Other,50,NULL,2/1/2023,Unknown,Germany,10",
    ].join("\n");

    expect(await syncLayoffsFromCsv(csv)).toEqual({ imported: 3, companies: 2 });
    expect(store.rows[0]).toMatchObject({ company: "HSBC Holdings", laidOff: 1000 });
    expect(store.rows.map((row) => row.date?.toISOString().slice(0, 10))).toEqual(["2024-01-15", "2023-02-01", "2023-01-10"]);

    const view = await layoffsForCompany("HSBC", "DevOps Engineer");
    expect(view.events).toHaveLength(2);
    expect(view.events[0]).toMatchObject({ laidOff: 1000, date: "2024-01-15", country: "United Kingdom", source: "Layoffs CSV mirrors" });
    expect(view.summary).toContain("1,000");
    expect(view.attribution).toContain("Layoffs CSV mirrors");
    expect(view.sources).toContain("Layoffs CSV mirrors");
  });

  it("dedupes overlapping events preferring the first source", async () => {
    const { dedupeLayoffRows, normalizeCompanyName } = await import("@/lib/job-search/layoffs");
    const base = {
      company: "Canva",
      normalizedCompany: normalizeCompanyName("Canva"),
      laidOff: 1271,
      percentage: 0.22,
      date: new Date(Date.UTC(2026, 10, 4)),
      location: "",
      country: "Australia",
      industry: "Software",
      sourceUrl: "https://layoffs.fyi/",
      rawNote: "",
    };
    const merged = dedupeLayoffRows([
      base,
      { ...base, sourceUrl: "https://layoffmap.com/", rawNote: "restructuring" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.sourceUrl).toBe("https://layoffs.fyi/");
  });

  it("merges configured sources and falls back to CSV when Airtable fails", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("airtable.com/embed")) {
        return new Response("nope", { status: 503 });
      }
      if (url.includes("raw.githubusercontent.com") && url.includes("layoffs.csv")) {
        const csv = [
          "company,location,industry,total_laid_off,percentage_laid_off,date,stage,country,funds_raised_millions",
          "Acme Labs,SF Bay Area,Software,100,0.1,3/1/2025,Series B,United States,50",
        ].join("\n");
        return new Response(csv, { status: 200, headers: { "content-type": "text/csv" } });
      }
      if (url.includes("latest.json")) {
        return new Response(
          JSON.stringify({
            notices: [
              {
                company: "Warn Co",
                company_canonical: "Warn Co",
                location: "Austin",
                state: "TX",
                employees_affected: 80,
                notice_date: "2026-09-01",
                notice_type: "Large Layoff",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("layoffmap.com")) {
        const payload = JSON.stringify([
          {
            id: "canva-2026-11-04",
            date: "2026-11-04",
            headcountAffected: 1271,
            percentOfWorkforce: 22,
            country: "Australia",
            reason: "restructuring",
            company: { name: "Canva", industry: "Software" },
          },
        ]);
        const escaped = payload.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
        return new Response(`<html>\\"recent\\":${escaped}</html>`, { status: 200 });
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { syncLayoffsFromUrl } = await import("@/lib/job-search/layoffs");
    const result = await syncLayoffsFromUrl();
    expect(result.sources).toEqual(expect.arrayContaining(["layoffs.csv", "warn", "layoffmap"]));
    expect(result.sources).not.toContain("layoffs.fyi");
    expect(result.imported).toBe(3);
    expect(result.companies).toBe(3);
    expect(store.rows.map((row) => row.company).sort()).toEqual(["Acme Labs", "Canva", "Warn Co"]);
  });
});
