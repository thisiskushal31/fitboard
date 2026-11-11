import { describe, expect, it } from "vitest";

import { buildPayCompare, offerSalaryOf, parseSalaryText } from "@/lib/job-search/salary";

describe("parseSalaryText", () => {
  it("reads currency ranges and k-suffix amounts", () => {
    expect(parseSalaryText("USD 80,000–120,000 a year")).toMatchObject({
      min: 80_000,
      max: 120_000,
      mid: 100_000,
      currency: "USD",
      period: "year",
    });
    expect(parseSalaryText("€75k-90k")).toMatchObject({ min: 75_000, max: 90_000, currency: "EUR" });
    expect(parseSalaryText("$90k")).toMatchObject({ min: 90_000, max: 90_000, currency: "USD" });
    expect(parseSalaryText("Competitive salary")).toBeNull();
  });

  it("detects hourly and monthly periods near the amount", () => {
    expect(parseSalaryText("USD 45 an hour")).toMatchObject({ period: "hour", mid: 45 });
    expect(parseSalaryText("GBP 4,500 a month")).toMatchObject({ period: "month", mid: 4_500 });
  });

  it("reads Indian LPA ranges as annual INR", () => {
    expect(parseSalaryText("₹12-18 LPA")).toMatchObject({
      min: 1_200_000,
      max: 1_800_000,
      currency: "INR",
      period: "year",
    });
    expect(parseSalaryText("CTC 15 LPA")).toMatchObject({ min: 1_500_000, max: 1_500_000, currency: "INR", period: "year" });
  });

  it("does not treat experience bands as salary", () => {
    expect(parseSalaryText("Exp : 3- 12 yrs\nWe ship improvements every day.", "INR")).toBeNull();
    expect(parseSalaryText("3–12 years of experience required", "INR")).toBeNull();
    expect(parseSalaryText("Experience: 2 to 5 years. Competitive salary.", "INR")).toBeNull();
  });

  it("ignores unrelated 'day' words when reading annual pay", () => {
    expect(parseSalaryText("USD 120,000 a year. We handle requests every day.")).toMatchObject({
      period: "year",
      mid: 120_000,
    });
  });
});

describe("offerSalaryOf", () => {
  it("returns null when the only numbers are experience years in the description", () => {
    expect(
      offerSalaryOf(
        {
          salary: "",
          title: "Software Engineer - Platforms & Productivity",
          description: "Exp : 3- 12 yrs. Build tools that handle requests every day.",
        },
        "INR",
      ),
    ).toBeNull();
  });
});

describe("buildPayCompare", () => {
  it("ranks companies with pay high to low and puts unknowns last", () => {
    const rows = buildPayCompare([
      { company: "LowCo", salary: "USD 60,000 a year" },
      { company: "HighCo", salary: "USD 140,000–160,000 a year" },
      { company: "QuietCo", salary: "" },
      { company: "HighCo", salary: "USD 150,000 a year" },
    ]);
    expect(rows.map((row) => row.company)).toEqual(["HighCo", "LowCo", "QuietCo"]);
    expect(rows[0]).toMatchObject({ unknown: false, postingCount: 2 });
    expect(rows[0].mid).toBeGreaterThan(140_000);
    expect(rows[2]).toMatchObject({ unknown: true, label: "Salary not listed" });
  });
});
