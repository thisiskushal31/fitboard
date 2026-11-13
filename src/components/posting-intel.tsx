"use client";

import { useEffect, useState } from "react";

import { loadPostingIntel, syncLayoffData } from "@/app/(app)/jobs/actions";
import { toast, toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/core/cn";

export type PostingIntelInput = {
  company: string;
  title: string;
  place?: string;
  country?: string;
  salary?: string;
  description?: string;
};

type IntelData = {
  offerLabel: string;
  marketLabel: string;
  marketSourceLabel: string | null;
  marketAttributionUrl: string | null;
  comparison: string | null;
  layoffs: {
    summary: string;
    events: { date: string | null; laidOff: number | null; roleMention: boolean; source: string }[];
    attribution: string;
    attributionUrl: string;
    sources: string[];
  };
};

function toIntel(data: {
  offerLabel: string;
  marketLabel: string;
  market: { sourceLabel?: string | null; attributionUrl?: string | null } | null;
  comparison: string | null;
  layoffs: {
    summary: string;
    events: { date: string | null; laidOff: number | null; roleMention: boolean; source: string }[];
    attribution: string;
    attributionUrl: string;
    sources: string[];
  };
}): IntelData {
  return {
    offerLabel: data.offerLabel,
    marketLabel: data.marketLabel,
    marketSourceLabel: data.market?.sourceLabel ?? null,
    marketAttributionUrl: data.market?.attributionUrl ?? null,
    comparison: data.comparison,
    layoffs: {
      summary: data.layoffs.summary,
      events: data.layoffs.events.slice(0, 3).map((event) => ({
        date: event.date,
        laidOff: event.laidOff,
        roleMention: event.roleMention,
        source: event.source,
      })),
      attribution: data.layoffs.attribution,
      attributionUrl: data.layoffs.attributionUrl,
      sources: data.layoffs.sources,
    },
  };
}

/**
 * Compact pay + layoff context for a posting (Find jobs detail / Agent cards).
 * Loads on the client so selection changes don't block the list.
 * Pass `lazy` on long lists (Agent) so opening the page doesn't fire one
 * server action per card and thrash the dev server.
 */
export function PostingIntelPanel({
  posting,
  className,
  lazy = false,
}: {
  posting: PostingIntelInput;
  className?: string;
  lazy?: boolean;
}) {
  const [open, setOpen] = useState(!lazy);
  const [intel, setIntel] = useState<IntelData | null>(null);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const requestKey = [
    posting.company,
    posting.title,
    posting.place ?? "",
    posting.country ?? "",
    posting.salary ?? "",
    (posting.description ?? "").slice(0, 4_000),
  ].join("\0");
  const loading = open && loadedKey !== requestKey;

  useEffect(() => {
    if (!open) return;
    let current = true;
    void loadPostingIntel({
      company: posting.company,
      title: posting.title,
      place: posting.place ?? "",
      country: posting.country ?? "",
      salary: posting.salary ?? "",
      description: (posting.description ?? "").slice(0, 4_000),
    }).then((result) => {
      if (!current) return;
      if (result.ok) setIntel(toIntel(result.data));
      setLoadedKey(requestKey);
    });
    return () => {
      current = false;
    };
  }, [open, requestKey, posting.company, posting.title, posting.place, posting.country, posting.salary, posting.description]);

  const refreshLayoffs = () => {
    setSyncing(true);
    void syncLayoffData({}).then((result) => {
      setSyncing(false);
      const ok = toastResult(result);
      if (!ok.ok) return;
      const sourceBit = Array.isArray(ok.data.sources) && ok.data.sources.length > 0 ? ` via ${ok.data.sources.join(", ")}` : "";
      toast(`Imported ${ok.data.imported} layoff events (${ok.data.companies} companies)${sourceBit}.`);
      setLoadedKey(null);
      void loadPostingIntel({
        company: posting.company,
        title: posting.title,
        place: posting.place ?? "",
        country: posting.country ?? "",
        salary: posting.salary ?? "",
        description: (posting.description ?? "").slice(0, 4_000),
      }).then((again) => {
        if (again.ok) setIntel(toIntel(again.data));
        setLoadedKey(requestKey);
      });
    });
  };

  if (!open) {
    return (
      <div className={cn("rounded-card border border-line bg-track/40 px-4 py-3", className)}>
        <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(true)}>
          Show Pay & Risk
        </Button>
      </div>
    );
  }

  return (
    <div className={cn("rounded-card border border-line bg-track/40 px-4 py-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-meta font-medium text-ink">Pay & Risk</p>
        <Button type="button" variant="secondary" size="sm" disabled={syncing || loading} onClick={refreshLayoffs}>
          {syncing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {loading || !intel ? (
        <p className="mt-2 text-sm text-muted" role="status">
          Looking up pay and layoffs…
        </p>
      ) : (
        <dl className="mt-2 flex flex-col gap-2 text-sm">
          <div>
            <dt className="text-meta text-muted">This offer</dt>
            <dd className="text-ink">{intel.offerLabel}</dd>
          </div>
          <div>
            <dt className="text-meta text-muted">Market for this role</dt>
            <dd className="text-ink">{intel.marketLabel}</dd>
            {intel.comparison ? <p className="text-meta text-muted">{intel.comparison}</p> : null}
            {intel.marketSourceLabel ? (
              <p className="mt-1 text-meta text-muted">
                {intel.marketAttributionUrl ? (
                  <a href={intel.marketAttributionUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                    {intel.marketSourceLabel}
                  </a>
                ) : (
                  intel.marketSourceLabel
                )}
              </p>
            ) : null}
          </div>
          <div>
            <dt className="text-meta text-muted">Layoffs</dt>
            <dd className="text-ink text-pretty">{intel.layoffs.summary}</dd>
            {intel.layoffs.events.length > 0 ? (
              <ul className="mt-1 list-disc pl-5 text-meta text-muted">
                {intel.layoffs.events.map((event, index) => (
                  <li key={`${event.date ?? "x"}-${event.source}-${index}`}>
                    {event.date ?? "Unknown date"}
                    {event.laidOff != null ? ` · ${event.laidOff.toLocaleString("en-US")} people` : ""}
                    {event.source ? ` · ${event.source}` : ""}
                    {event.roleMention ? " · may touch this role/team" : ""}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-1 text-meta text-muted">
              <a href={intel.layoffs.attributionUrl} target="_blank" rel="noreferrer" className="underline-offset-2 hover:underline">
                {intel.layoffs.attribution}
              </a>
            </p>
          </div>
        </dl>
      )}
    </div>
  );
}
