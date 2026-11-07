import { describe, expect, it } from "vitest";

import { ignoreNegativePerformanceMeasures } from "@/lib/core/dev-performance";

function clock(): Pick<Performance, "measure"> {
  return {
    measure: (() => ({}) as PerformanceMeasure) as Performance["measure"],
  };
}

describe("ignoreNegativePerformanceMeasures", () => {
  it("drops the profiler measurement the browser rejects for a negative end time", () => {
    const target = clock();
    target.measure = (() => {
      throw new TypeError(
        "Failed to execute 'measure' on 'Performance': '\\u200bLoginPage' cannot have a negative time stamp.",
      );
    }) as Performance["measure"];
    ignoreNegativePerformanceMeasures(target);
    expect(target.measure("LoginPage", { start: 0, end: -1 })).toBeUndefined();
  });

  it("drops the same measurement when the browser calls the end time non-finite", () => {
    const target = clock();
    target.measure = (() => {
      throw new TypeError(
        "Failed to execute 'measure' on 'Performance': Failed to read the 'end' property from 'PerformanceMeasureOptions': The provided double value is non-finite.",
      );
    }) as Performance["measure"];
    ignoreNegativePerformanceMeasures(target);
    expect(target.measure("LoginPage", { start: 0, end: Number.NEGATIVE_INFINITY })).toBeUndefined();
  });

  it("still reports any other measurement failure", () => {
    const target = clock();
    target.measure = (() => {
      throw new TypeError("Failed to execute 'measure' on 'Performance': The mark 'missing' does not exist.");
    }) as Performance["measure"];
    ignoreNegativePerformanceMeasures(target);
    expect(() => target.measure("LoginPage", { start: 0, end: 1 })).toThrow(/does not exist/);
  });

  it("returns a measurement that succeeded", () => {
    const target = clock();
    const mark = { name: "ok" } as PerformanceMeasure;
    target.measure = (() => mark) as Performance["measure"];
    ignoreNegativePerformanceMeasures(target);
    expect(target.measure("ok", { start: 0, end: 1 })).toBe(mark);
  });
});
