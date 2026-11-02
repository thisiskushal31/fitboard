import { describe, expect, it } from "vitest";

import { buildCareerReport } from "@/lib/career/career";

describe("career path", () => {
  it("reports skills a track asked for that the profile lacks", () => {
    const report = buildCareerReport(
      [{ title: "Platform Engineer", description: "Kubernetes, Backstage, and Crossplane for a multi-tenant platform.", place: "India", remote: false }],
      ["Kubernetes"],
      { current: ["Platform Engineer"], next: [], destination: [], trending: [] },
    );
    const role = report.roles[0];
    expect(role.listingCount).toBe(1);
    expect(role.have).toContain("kubernetes");
    expect(role.lacking).toContain("backstage");
    expect(role.closeness.toLowerCase()).toContain("stretch");
  });
});
