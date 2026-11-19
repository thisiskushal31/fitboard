import { describe, expect, it } from "vitest";

import { eventFilterFromParams, eventFilterHref, eventFilterSchema } from "@/lib/events/types";

describe("the Events screen's filter in its address", () => {
  it("reads the filter, with defaults for what's missing or wrong", () => {
    expect(eventFilterFromParams({})).toEqual(eventFilterSchema.parse({}));
    expect(
      eventFilterFromParams({
        q: ["react", "x"],
        place: "city",
        source: "techconf",
        format: "virtual",
        min: "70",
        view: "saved",
        sort: "soon",
      }),
    ).toEqual({
      q: "react",
      place: "city",
      source: "TECHCONF",
      format: "VIRTUAL",
      minScore: 70,
      status: "SAVED",
      sort: "soon",
    });
    expect(eventFilterFromParams({ place: "mars" })).toEqual(eventFilterSchema.parse({}));
  });

  it("writes it back, leaving out the defaults", () => {
    expect(eventFilterHref(eventFilterSchema.parse({}))).toBe("/events");
    const filter = eventFilterSchema.parse({
      q: "ai",
      place: "country",
      source: "TECHMEETUPS",
      format: "IN_PERSON",
      minScore: 50,
      status: "DISMISSED",
      sort: "match",
    });
    expect(eventFilterHref(filter)).toBe("/events?q=ai&place=country&source=techmeetups&format=in_person&min=50&view=dismissed&sort=match");
    expect(eventFilterFromParams(Object.fromEntries(new URL(`https://x${eventFilterHref(filter)}`).searchParams))).toEqual(filter);
  });
});
