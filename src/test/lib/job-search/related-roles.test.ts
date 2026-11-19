import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ai", () => ({
  getAiProvider: async () => {
    throw new Error("no ai in unit heuristics test");
  },
}));

describe("specialtyTokensRelated", () => {
  it("treats compound role tokens as related without a hardcoded map", async () => {
    const { specialtyTokensRelated, roleMatchesQuery } = await import("@/lib/job-search/related-roles-core");
    expect(specialtyTokensRelated("devops", "devsecops")).toBe(true);
    expect(specialtyTokensRelated("devsecops", "devops")).toBe(true);
    expect(specialtyTokensRelated("devops", "mlops")).toBe(false);
    expect(specialtyTokensRelated("backend", "frontend")).toBe(false);
    expect(roleMatchesQuery("DevSecOps Engineer", "DevOps Engineer")).toBe(true);
    expect(roleMatchesQuery("MLOps Engineer", "DevOps Engineer")).toBe(false);
    expect(roleMatchesQuery("Frontend Engineer", "Backend Engineer")).toBe(false);
  });

  it("matches specialty across generic titles for any discipline", async () => {
    const { roleMatchesQuery } = await import("@/lib/job-search/related-roles-core");
    // Same specialty, different generic title words (engineer / consultant / architect).
    expect(roleMatchesQuery("DevOps Consultant", "DevOps Engineer")).toBe(true);
    expect(roleMatchesQuery("Principal Salesforce Architect", "Salesforce Engineer")).toBe(true);
    expect(roleMatchesQuery("Staff Backend Consultant", "Backend Engineer")).toBe(true);
    expect(roleMatchesQuery("Frontend Consultant", "Backend Engineer")).toBe(false);
  });
});
