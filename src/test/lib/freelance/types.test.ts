import { describe, expect, it } from "vitest";

import { freelanceFilterFromParams, freelanceFilterHref, freelanceFilterSchema } from "@/lib/freelance/types";

describe("the Freelance screen's filter in its address", () => {
  it("reads the filter, with defaults for what's missing or wrong", () => {
    expect(freelanceFilterFromParams({})).toEqual(freelanceFilterSchema.parse({}));
    expect(
      freelanceFilterFromParams({
        q: ["android", "x"],
        place: "remote",
        source: "hn",
        type: "contract",
        min: "70",
        view: "saved",
        sort: "newest",
      }),
    ).toEqual({
      q: "android",
      place: "remote",
      source: "HN",
      engagement: "CONTRACT",
      minScore: 70,
      status: "SAVED",
      sort: "newest",
    });
    expect(freelanceFilterFromParams({ place: "mars" })).toEqual(freelanceFilterSchema.parse({}));
  });

  it("writes it back, leaving out the defaults", () => {
    expect(freelanceFilterHref(freelanceFilterSchema.parse({}))).toBe("/freelance");
    const filter = freelanceFilterSchema.parse({
      q: "react",
      place: "country",
      source: "WWR",
      engagement: "PROJECT",
      minScore: 50,
      status: "DISMISSED",
      sort: "newest",
    });
    expect(freelanceFilterHref(filter)).toBe("/freelance?q=react&place=country&source=wwr&type=project&min=50&view=dismissed&sort=newest");
    expect(freelanceFilterFromParams(Object.fromEntries(new URL(`https://x${freelanceFilterHref(filter)}`).searchParams))).toEqual(filter);
  });
});
