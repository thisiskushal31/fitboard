import { describe, expect, it } from "vitest";

import { companyMatchesSelected, filterByCompany, normalizeCompanyName } from "@/lib/job-search/company-filter";

describe("company filter", () => {
  it("normalizes punctuation and case", () => {
    expect(normalizeCompanyName("  Deloitte  India ")).toBe("deloitte india");
    expect(normalizeCompanyName("Acme, Inc.")).toBe("acme inc");
  });

  it("matches equals and contains either way", () => {
    expect(companyMatchesSelected("Deloitte India", "Deloitte India")).toBe(true);
    expect(companyMatchesSelected("Deloitte India Pvt Ltd", "Deloitte India")).toBe(true);
    expect(companyMatchesSelected("Deloitte", "Deloitte India")).toBe(true);
    expect(companyMatchesSelected("Accenture", "Deloitte India")).toBe(false);
    expect(companyMatchesSelected("Acme", "")).toBe(true);
  });

  it("filters a list by selected company", () => {
    const postings = [
      { company: "Deloitte India", title: "A" },
      { company: "Accenture", title: "B" },
      { company: "Deloitte India Pvt Ltd", title: "C" },
    ];
    expect(filterByCompany(postings, "Deloitte India").map((row) => row.title)).toEqual(["A", "C"]);
    expect(filterByCompany(postings, "").map((row) => row.title)).toEqual(["A", "B", "C"]);
  });
});
