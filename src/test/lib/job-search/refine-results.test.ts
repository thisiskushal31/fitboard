import { beforeEach, describe, expect, it, vi } from "vitest";

import { EMPTY_QUERY, type FoundPosting } from "@/lib/job-search/search";

vi.mock("@/lib/job-search/related-roles", () => ({
  expandRelatedRoleTerms: vi.fn(async () => []),
  roleMatchesQuery: (title: string, keywords: string) => title.toLowerCase().includes(keywords.toLowerCase().split(/\s+/)[0] ?? ""),
}));

const posting = (title: string, company: string, source: FoundPosting["source"] = "BOARDSEARCH"): FoundPosting => ({
  source,
  externalId: title,
  title,
  company,
  place: "Berlin",
  remote: false,
  salary: "",
  postedAt: null,
  url: "https://jobs.example/1",
  via: "",
  description: "",
  complete: true,
});

describe("refineFoundPostings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("filters by company and skips role refine when keywords are empty", async () => {
    const { refineFoundPostings } = await import("@/lib/job-search/refine-results");
    const { expandRelatedRoleTerms } = await import("@/lib/job-search/related-roles");
    const kept = await refineFoundPostings(
      [posting("DevOps Consultant", "Deloitte India"), posting("Analyst", "Accenture")],
      { ...EMPTY_QUERY, company: "Deloitte India" },
      "BOARDSEARCH",
    );
    expect(kept.map((row) => row.company)).toEqual(["Deloitte India"]);
    expect(expandRelatedRoleTerms).not.toHaveBeenCalled();
  });

  it("keeps API results that share the query without dropping nearby titles", async () => {
    const { refineFoundPostings } = await import("@/lib/job-search/refine-results");
    const { expandRelatedRoleTerms } = await import("@/lib/job-search/related-roles");
    const kept = await refineFoundPostings(
      [posting("Senior Product Designer, Payments", "Acme"), posting("UX Researcher", "Acme")],
      { ...EMPTY_QUERY, keywords: "product designer", company: "Acme" },
      "BOARDSEARCH",
    );
    expect(kept.map((row) => row.title)).toEqual(["Senior Product Designer, Payments", "UX Researcher"]);
    expect(expandRelatedRoleTerms).not.toHaveBeenCalled();
  });

  it("applies flexible title match for PUBLIC_BOARDS", async () => {
    const { refineFoundPostings } = await import("@/lib/job-search/refine-results");
    const kept = await refineFoundPostings(
      [
        posting("DevOps Consultant", "Acme", "PUBLIC_BOARDS"),
        posting("Sales Manager", "Acme", "PUBLIC_BOARDS"),
      ],
      { ...EMPTY_QUERY, keywords: "DevOps Engineer", company: "Acme" },
      "PUBLIC_BOARDS",
    );
    expect(kept.map((row) => row.title)).toEqual(["DevOps Consultant"]);
  });
});
