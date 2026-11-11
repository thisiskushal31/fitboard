"use client";

import { useEffect, useState } from "react";

import { PayCompareChart } from "@/components/pay-compare-chart";
import type { ShownPosting } from "@/lib/job-search/search";

import { loadMarketSalary } from "./actions";

/** Pay compare for the current search result set, with optional market band. */
export function PayCompareSection({
  postings,
  keywords,
  place,
  country,
}: {
  postings: readonly ShownPosting[];
  keywords: string;
  place: string;
  country: string;
}) {
  const [market, setMarket] = useState<{
    median: number | null;
    currency: string | null;
    label: string | null;
    sourceLabel: string | null;
  }>({
    median: null,
    currency: null,
    label: null,
    sourceLabel: null,
  });

  useEffect(() => {
    let current = true;
    if (!keywords.trim() || !country.trim()) return;
    void loadMarketSalary({ title: keywords.trim(), place, country }).then((result) => {
      if (!current || !result.ok) return;
      setMarket({
        median: result.data.median,
        currency: result.data.currency,
        label: result.data.label,
        sourceLabel: result.data.sourceLabel,
      });
    });
    return () => {
      current = false;
    };
  }, [keywords, place, country]);

  if (postings.length === 0) return null;

  const marketLabel =
    market.label && market.sourceLabel ? `${market.label} · ${market.sourceLabel}` : market.label;

  return (
    <PayCompareChart
      postings={postings}
      marketMedian={market.median}
      marketCurrency={market.currency}
      marketLabel={marketLabel}
    />
  );
}
