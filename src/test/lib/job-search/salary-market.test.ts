import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = vi.hoisted(() => ({ path: "" }));
vi.mock("@/lib/core/env", () => ({
  env: {
    get FITBOARD_DATA_DIR() {
      return dataDir.path;
    },
    get FITBOARD_JOBS_TEST_BASE_URL() {
      return undefined;
    },
    get FITBOARD_GLASSDOOR_API_KEY() {
      return undefined;
    },
  },
}));

vi.mock("@/lib/core/log", () => ({ logServerError: vi.fn() }));

vi.mock("@/lib/job-search/config", () => ({
  loadJobSearchConfig: async () => ({
    adzuna: { appId: "app", key: "key", keyState: "set" },
  }),
}));

describe("marketSalaryForRole", () => {
  beforeEach(async () => {
    dataDir.path = await mkdtemp(path.join(tmpdir(), "fitboard-salary-"));
  });

  afterEach(async () => {
    await rm(dataDir.path, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("scores occupation titles dynamically without an alias table", async () => {
    const { scoreOccupationTitle } = await import("@/lib/job-search/salary-market");
    expect(scoreOccupationTitle("DevOps Engineer", "DevOps Engineer")).toBeGreaterThanOrEqual(100);
    expect(scoreOccupationTitle("DevOps Engineer", "DevOps Architect")).toBeGreaterThan(
      scoreOccupationTitle("DevOps Engineer", "Curriculum Developer"),
    );
    expect(scoreOccupationTitle("DevOps Engineer", "Registered Nurse")).toBe(0);
  });

  it("builds a market band from Adzuna histogram data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/histogram")) {
          return new Response(JSON.stringify({ histogram: { "80000": "10", "100000": "40", "140000": "10" } }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      }),
    );

    const { marketSalaryForRole } = await import("@/lib/job-search/salary-market");
    const market = await marketSalaryForRole({ title: "DevOps Engineer", country: "us" });
    expect(market).toMatchObject({ currency: "USD", source: "adzuna", sourceLabel: "Adzuna" });
    expect(market?.median).toBeGreaterThan(0);
    expect(market?.label).toContain("USD");
  });

  it("falls back to PayCrunch when Adzuna has no data", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("adzuna.com") || url.includes("/histogram") || url.includes("/history")) {
          return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (url.includes("glassdoor.com")) {
          return new Response("<html><title>Security | Glassdoor</title></html>", { status: 403 });
        }
        if (url.includes("/api/v1/jobs.json")) {
          return new Response(
            JSON.stringify({
              jobs: [{ slug: "devops-engineer-salary", name: "DevOps Engineer", median: 135980, estimated: false }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/api/v1/jobs/devops-engineer-salary.json")) {
          return new Response(
            JSON.stringify({
              name: "DevOps Engineer",
              estimated: false,
              source_release: "BLS OEWS May 2025",
              wage: { currency: "USD", p25: 105210, median: 135980, p75: 171980 },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("missing", { status: 404 });
      }),
    );

    const { marketSalaryForRole } = await import("@/lib/job-search/salary-market");
    const market = await marketSalaryForRole({ title: "DevOps Engineer", country: "us" });
    expect(market).toMatchObject({
      source: "paycrunch",
      sourceLabel: "PayCrunch (BLS OEWS)",
      currency: "USD",
      median: 135980,
      p25: 105210,
      p75: 171980,
    });
  });

  it("reads AmbitionBox salary ranges from __NEXT_DATA__", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("adzuna") || url.includes("/histogram") || url.includes("/history")) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (url.includes("ambitionbox.com/profile/devops-engineer-salary")) {
          const next = {
            props: {
              pageProps: {
                salaryData: {
                  profileSalaryData: {
                    jobProfileName: "Devops Engineer",
                    medianCtc: 922792,
                    percentiles: { percentile25: 520756, percentile75: 944717 },
                  },
                },
              },
            },
          };
          return new Response(`<html><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(next)}</script></html>`, {
            status: 200,
          });
        }
        return new Response("missing", { status: 404 });
      }),
    );

    const { marketSalaryForRole } = await import("@/lib/job-search/salary-market");
    const market = await marketSalaryForRole({ title: "DevOps Engineer", country: "in" });
    expect(market).toMatchObject({
      source: "ambitionbox",
      sourceLabel: "AmbitionBox",
      currency: "INR",
      median: 922792,
      p25: 520756,
      p75: 944717,
    });
  });

  it("parses Glassdoor HTML salary estimates", async () => {
    const { parseGlassdoorSalaryHtml } = await import("@/lib/job-search/salary-market");
    const { salarySourceById } = await import("@/lib/job-search/salary-sources");
    const source = salarySourceById("glassdoor");
    expect(source).toBeTruthy();
    const html = `<html><script>window.app={"medianTotalPay":185000,"percentile25":150000,"percentile75":220000}</script></html>`;
    const market = parseGlassdoorSalaryHtml(html, source!, "Software Engineer");
    expect(market).toMatchObject({ source: "glassdoor", median: 185000, p25: 150000, p75: 220000 });

    const percentile = parseGlassdoorSalaryHtml(
      `<html>"percentile50":210000,"p25":180000,"p75":250000</html>`,
      source!,
      "SRE",
    );
    expect(percentile).toMatchObject({ median: 210000, p25: 180000, p75: 250000 });
    expect(parseGlassdoorSalaryHtml(`<html><title>Security | Glassdoor</title></html>`, source!, "SRE")).toBeNull();
  });

  it("compares offers to market median and skips currency mismatches", async () => {
    const { offerVsMarket } = await import("@/lib/job-search/salary-market");
    const market = {
      currency: "USD",
      median: 100000,
      p25: 80000,
      p75: 120000,
      label: "USD 80k–120k",
      source: "adzuna",
      sourceLabel: "Adzuna",
      note: "Adzuna",
    };
    expect(offerVsMarket(null, market)).toBeNull();
    expect(offerVsMarket({ mid: 100000, min: 100000, max: 100000, currency: "EUR", label: "EUR 100k", period: "year" }, market)).toBeNull();
    expect(offerVsMarket({ mid: 102000, min: 102000, max: 102000, currency: "USD", label: "USD 102k", period: "year" }, market)).toBe(
      "About in line with the market median.",
    );
    expect(offerVsMarket({ mid: 120000, min: 120000, max: 120000, currency: "USD", label: "USD 120k", period: "year" }, market)).toBe(
      "About 20% above the market median.",
    );
    expect(offerVsMarket({ mid: 80000, min: 80000, max: 80000, currency: "USD", label: "USD 80k", period: "year" }, market)).toBe(
      "About 20% below the market median.",
    );
  });

  it("builds slug candidates and returns null for blank title or country", async () => {
    const { titleSlugCandidates, marketSalaryForRole } = await import("@/lib/job-search/salary-market");
    expect(titleSlugCandidates("DevOps Engineer")).toEqual(expect.arrayContaining(["devops-engineer"]));
    expect(await marketSalaryForRole({ title: "  ", country: "us" })).toBeNull();
    expect(await marketSalaryForRole({ title: "DevOps Engineer", country: "" })).toBeNull();
  });

  it("uses Adzuna history when the histogram is empty and caches the result", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/histogram")) {
        return new Response(JSON.stringify({ histogram: {} }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("/history")) {
        return new Response(JSON.stringify({ month: { "2025-01": "90000", "2025-02": "95000", "2025-03": "100000" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const { marketSalaryForRole } = await import("@/lib/job-search/salary-market");
    const first = await marketSalaryForRole({ title: "Platform Engineer", country: "us" });
    expect(first).toMatchObject({ source: "adzuna", currency: "USD" });
    expect(first?.median).toBeGreaterThan(0);
    const calls = fetchMock.mock.calls.length;
    const second = await marketSalaryForRole({ title: "Platform Engineer", country: "us" });
    expect(second?.median).toBe(first?.median);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it("caches a miss when no salary source returns data", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { marketSalaryForRole } = await import("@/lib/job-search/salary-market");
    expect(await marketSalaryForRole({ title: "Obscure Role XYZ", country: "us" })).toBeNull();
    const calls = fetchMock.mock.calls.length;
    expect(await marketSalaryForRole({ title: "Obscure Role XYZ", country: "us" })).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(calls);
  });
});
