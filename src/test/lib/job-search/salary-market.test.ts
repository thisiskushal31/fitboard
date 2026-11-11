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
  });
});
