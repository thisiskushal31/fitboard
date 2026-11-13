import { beforeEach, describe, expect, it, vi } from "vitest";

const stubs = vi.hoisted(() => ({
  marketSalaryForRole: vi.fn(),
  layoffsForCompany: vi.fn(),
}));

vi.mock("@/lib/job-search/salary-market", async () => {
  const actual = await vi.importActual<typeof import("@/lib/job-search/salary-market")>("@/lib/job-search/salary-market");
  return {
    ...actual,
    marketSalaryForRole: stubs.marketSalaryForRole,
  };
});

vi.mock("@/lib/job-search/layoffs", () => ({
  layoffsForCompany: stubs.layoffsForCompany,
}));

describe("loadPostingIntel", () => {
  beforeEach(() => {
    vi.resetModules();
    stubs.marketSalaryForRole.mockReset();
    stubs.layoffsForCompany.mockReset();
    stubs.layoffsForCompany.mockResolvedValue({
      company: "Acme",
      events: [],
      totalLaidOff: null,
      latestDate: null,
      attribution: "Layoffs CSV mirrors",
      attributionUrl: "https://layoffs.fyi/",
      sources: [],
      summary: "No layoff records found for this company.",
    });
  });

  it("skips market lookup when country is missing", async () => {
    stubs.marketSalaryForRole.mockResolvedValue(null);
    const { loadPostingIntel } = await import("@/lib/job-search/posting-intel");
    const intel = await loadPostingIntel({ company: "Acme", title: "DevOps Engineer", salary: "$120,000" });
    expect(stubs.marketSalaryForRole).not.toHaveBeenCalled();
    expect(stubs.layoffsForCompany).toHaveBeenCalledWith("Acme", "DevOps Engineer");
    expect(intel.market).toBeNull();
    expect(intel.marketLabel).toBe("No market data");
    expect(intel.offerLabel).toContain("120");
  });

  it("loads market and layoffs when country is set", async () => {
    stubs.marketSalaryForRole.mockResolvedValue({
      currency: "USD",
      median: 140000,
      p25: 110000,
      p75: 170000,
      label: "USD 110k–170k",
      source: "adzuna",
      sourceLabel: "Adzuna",
      attributionUrl: "https://www.adzuna.com/",
      detail: "Adzuna",
    });
    const { loadPostingIntel } = await import("@/lib/job-search/posting-intel");
    const intel = await loadPostingIntel({
      company: "Acme",
      title: "DevOps Engineer",
      place: "Austin",
      country: "us",
      salary: "$160,000",
    });
    expect(stubs.marketSalaryForRole).toHaveBeenCalledWith({ title: "DevOps Engineer", place: "Austin", country: "us" });
    expect(intel.market?.median).toBe(140000);
    expect(intel.marketLabel).toBe("USD 110k–170k");
    expect(intel.comparison).toMatch(/above the market median/i);
  });

  it("falls back to the raw salary string or Not listed", async () => {
    stubs.marketSalaryForRole.mockResolvedValue(null);
    const { loadPostingIntel } = await import("@/lib/job-search/posting-intel");
    const listed = await loadPostingIntel({ company: "Acme", title: "Role", salary: "  Competitive  " });
    expect(listed.offer).toBeNull();
    expect(listed.offerLabel).toBe("Competitive");

    const blank = await loadPostingIntel({ company: "Acme", title: "Role", salary: "   " });
    expect(blank.offerLabel).toBe("Not listed");
  });
});
