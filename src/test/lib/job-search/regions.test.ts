import { describe, expect, it } from "vitest";

import { detectRegions, LOCATION_WEIGHTS, regionRank } from "@/lib/job-search/regions";

describe("region rank", () => {
  it("ranks remote first and India ahead of the US", () => {
    expect(regionRank(detectRegions("worldwide", true))).toBe(LOCATION_WEIGHTS.Remote);
    expect(LOCATION_WEIGHTS.India).toBeGreaterThan(LOCATION_WEIGHTS.US);
    expect(detectRegions("Berlin, Germany")).toEqual(expect.arrayContaining(["Germany", "EMEA"]));
  });
});
