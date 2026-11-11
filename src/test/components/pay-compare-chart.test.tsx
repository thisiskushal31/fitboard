import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PayCompareChart } from "@/components/pay-compare-chart";

describe("PayCompareChart", () => {
  it("ranks companies by mid salary for targeting", () => {
    render(
      <PayCompareChart
        postings={[
          { company: "Alpha", salary: "USD 90,000 a year" },
          { company: "Beta", salary: "USD 140,000 a year" },
          { company: "Gamma", salary: "" },
        ]}
        marketMedian={100_000}
        marketCurrency="USD"
        marketLabel="USD 100,000 a year"
      />,
    );
    expect(screen.getByRole("heading", { name: "Pay compare" })).toBeInTheDocument();
    const items = screen.getAllByRole("listitem").map((item) => item.textContent);
    expect(items[0]).toContain("Beta");
    expect(items[1]).toContain("Alpha");
    expect(items[2]).toContain("Gamma");
    expect(items[2]).toContain("Salary not listed");
    expect(screen.getByText(/Market reference/)).toHaveTextContent("USD 100,000 a year");
  });
});
