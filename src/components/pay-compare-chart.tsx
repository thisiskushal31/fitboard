"use client";

import { useMemo } from "react";

import { buildPayCompare, type PayCompareRow } from "@/lib/job-search/salary";
import { cn } from "@/lib/core/cn";

type PostingLike = { company: string; salary?: string; title?: string; description?: string };

/**
 * Horizontal bars ranking companies in the current search by mid salary.
 * Highest pay first — a quick signal for which employers to target.
 */
export function PayCompareChart({
  postings,
  marketMedian = null,
  marketCurrency = null,
  marketLabel = null,
  className,
}: {
  postings: readonly PostingLike[];
  marketMedian?: number | null;
  marketCurrency?: string | null;
  marketLabel?: string | null;
  className?: string;
}) {
  const rows = useMemo(() => buildPayCompare(postings), [postings]);
  const known = rows.filter((row) => !row.unknown && row.mid != null);
  const max = Math.max(...known.map((row) => row.mid!), marketMedian ?? 0, 1);

  if (postings.length === 0) return null;

  return (
    <section className={cn("mx-10 mb-8 max-w-[960px] rounded-panel border border-line-card bg-card p-6", className)} aria-labelledby="pay-compare-heading">
      <h2 id="pay-compare-heading" className="font-serif text-section">
        Pay compare
      </h2>
      <p className="mt-1 text-sm text-muted">
        Companies in this search ranked by listed mid salary. Target higher bars first when pay matters.
        {marketLabel ? ` Market reference: ${marketLabel}.` : ""}
      </p>

      {known.length === 0 ? (
        <p className="mt-4 text-sm text-muted">No numeric salaries in these results yet. Open a posting for market data when Adzuna keys are set.</p>
      ) : (
        <ul className="mt-5 flex flex-col gap-3" role="list">
          {rows.map((row) => (
            <PayBar key={row.company} row={row} max={max} marketMedian={marketMedian} marketCurrency={marketCurrency} />
          ))}
        </ul>
      )}
    </section>
  );
}

function PayBar({
  row,
  max,
  marketMedian,
  marketCurrency,
}: {
  row: PayCompareRow;
  max: number;
  marketMedian: number | null;
  marketCurrency: string | null;
}) {
  const width = row.mid != null && max > 0 ? Math.max(4, Math.round((row.mid / max) * 100)) : 0;
  const marketLeft =
    marketMedian != null && max > 0 && (!marketCurrency || !row.currency || marketCurrency === row.currency)
      ? Math.min(100, Math.round((marketMedian / max) * 100))
      : null;

  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink">
          {row.company}
          {row.postingCount > 1 ? <span className="font-normal text-muted"> · {row.postingCount} roles</span> : null}
        </span>
        <span className="text-meta text-muted">{row.label}</span>
      </div>
      <div className="relative h-3 overflow-hidden rounded-control bg-track" aria-hidden>
        {!row.unknown ? (
          <div className="absolute inset-y-0 left-0 rounded-control bg-ink/80" style={{ width: `${width}%` }} />
        ) : (
          <div className="absolute inset-y-0 left-0 w-full rounded-control bg-track" />
        )}
        {marketLeft != null ? (
          <div className="absolute inset-y-0 w-px bg-danger/80" style={{ left: `${marketLeft}%` }} title="Market median" />
        ) : null}
      </div>
    </li>
  );
}
