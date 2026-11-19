"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { PageHeader } from "@/components/page-header";
import { ScoreBadge } from "@/components/score-badge";
import { toast, toastResult } from "@/components/toast";
import { Button, buttonClassName } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useJob } from "@/hooks/use-job";
import { cn } from "@/lib/core/cn";
import { formatDateTime } from "@/lib/core/dates";
import {
  FREELANCE_ENGAGEMENT_LABEL,
  FREELANCE_ENGAGEMENTS,
  FREELANCE_SOURCE_INFO,
  FREELANCE_SOURCES,
  freelanceFilterHref,
  type FreelanceFilter,
  type FreelanceRefresh,
  type FreelanceStatusName,
  type FreelanceView,
} from "@/lib/freelance/types";
import { postedAgo } from "@/lib/job-search/search";

import { refreshFreelanceNow, removeFreelanceForGood, setFreelanceStatus } from "./actions";

export type FreelanceScreenProps = {
  filter: FreelanceFilter;
  list: { opportunities: FreelanceView[]; total: number; counts: Record<FreelanceStatusName, number> };
  lastRefresh: FreelanceRefresh | null;
  refreshJobId: string | null;
  city: string;
  country: string;
  aiReady: boolean;
  today: string;
  /** Browser/server zone so “Last refreshed” matches SSR and the client. */
  timeZone: string;
};

const VIEWS: { status: FreelanceStatusName; label: string }[] = [
  { status: "NEW", label: "To look at" },
  { status: "SAVED", label: "Saved" },
  { status: "CONTACTED", label: "Contacted" },
  { status: "DISMISSED", label: "Dismissed" },
];

/**
 * The Freelance screen: contract, project, and temporary gigs from public
 * sources, ranked against the profile. Fitboard sends nothing.
 */
export function FreelanceScreen({ filter, list, lastRefresh, refreshJobId, city, country, aiReady, today, timeZone }: FreelanceScreenProps) {
  const router = useRouter();
  const [jobId, setJobId] = useState(refreshJobId);
  const [starting, startTransition] = useTransition();

  const job = useJob<FreelanceRefresh>(jobId, 0, (update) => {
    if (update.status !== "DONE" && update.status !== "FAILED") return;
    setJobId(null);
    if (update.status === "FAILED") return toast(update.error ?? "The refresh didn't finish. Try again.");
    const added = update.result?.added ?? 0;
    toast(added > 0 ? `Found ${added} new ${added === 1 ? "opportunity" : "opportunities"}.` : "No new opportunities this time.");
    router.refresh();
  });
  const refreshing = Boolean(jobId) && (!job || job.status === "QUEUED" || job.status === "RUNNING");

  const refresh = () =>
    startTransition(async () => {
      const result = toastResult(await refreshFreelanceNow({}));
      if (result.ok) setJobId(result.data.jobId);
    });

  const go = (change: Partial<FreelanceFilter>) => router.replace(freelanceFilterHref({ ...filter, ...change }), { scroll: false });

  return (
    <>
      <PageHeader
        title="Freelance"
        description="Contract, project, and temporary gigs from public sources, ranked against your profile. You open each posting yourself — Fitboard never applies for you."
        actions={
          <Button aria-disabled={refreshing || starting || undefined} onClick={() => !refreshing && !starting && refresh()}>
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        }
      />
      <div className="flex flex-col gap-6 px-10 pb-20">
        <RefreshStatus lastRefresh={lastRefresh} refreshing={refreshing} step={job?.step ?? null} today={today} timeZone={timeZone} />
        {lastRefresh && (
          <>
            <ViewTabs filter={filter} counts={list.counts} />
            <Filters filter={filter} city={city} country={country} onChange={go} />
            {list.opportunities.length === 0 ? (
              <Empty filter={filter} />
            ) : (
              <>
                <p className="text-meta text-muted">
                  {list.total > list.opportunities.length
                    ? `The best ${list.opportunities.length} of ${list.total}`
                    : `${list.total} ${list.total === 1 ? "opportunity" : "opportunities"}`}
                  {filter.sort === "match" ? ", best match first." : ", newest first."}
                </p>
                <ul className="flex flex-col gap-3">
                  {list.opportunities.map((gig) => (
                    <li key={`${gig.id}:${gig.status}:${gig.score}`}>
                      <FreelanceCard gig={gig} aiReady={aiReady} today={today} />
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function RefreshStatus({
  lastRefresh,
  refreshing,
  step,
  today,
  timeZone,
}: {
  lastRefresh: FreelanceRefresh | null;
  refreshing: boolean;
  step: string | null;
  today: string;
  timeZone: string;
}) {
  if (refreshing) {
    return (
      <p role="status" className="rounded-card border border-line-card bg-card px-4 py-3 text-meta text-muted">
        {step ?? "Starting…"} This takes a minute or two.
      </p>
    );
  }
  if (!lastRefresh) {
    return (
      <div role="note" className="flex flex-col gap-2 rounded-panel border border-line-card bg-card px-6 py-5 text-sm text-pretty">
        <p>
          Press <strong>Refresh</strong> to look for freelance work. Fitboard reads Hacker News&apos; “Seeking freelancer?” thread, Freelancer.com project feeds,
          Remotive and Remote OK contract-style listings, and We Work Remotely — then ranks what it finds against your profile.
        </p>
        <p className="text-muted">After that it refreshes once a day while you use this screen. Nothing is sent to anyone.</p>
      </div>
    );
  }
  const failed = lastRefresh.sources.filter((source) => source.error);
  return (
    <div className="flex flex-col gap-2 text-meta text-muted">
      <p>
        Last refreshed {formatDateTime(new Date(lastRefresh.at), timeZone, new Date(today))}:{" "}
        {lastRefresh.sources
          .filter((source) => !source.error)
          .map((source) => `${FREELANCE_SOURCE_INFO[source.source].name} ${source.found}`)
          .join(" · ")}
        .
      </p>
      {failed.length > 0 && (
        <p role="note" className="rounded-card bg-warning-surface px-4 py-2.5 text-warning">
          {failed.map((source) => source.error).join("; ")}. {failed.length < lastRefresh.sources.length ? "The others worked. " : ""}The next refresh tries
          again.
        </p>
      )}
    </div>
  );
}

function ViewTabs({ filter, counts }: { filter: FreelanceFilter; counts: Record<FreelanceStatusName, number> }) {
  return (
    <nav aria-label="Freelance views" className="flex flex-wrap gap-1.5">
      {VIEWS.map((view) => (
        <Link
          key={view.status}
          href={freelanceFilterHref({ ...filter, status: view.status })}
          aria-current={view.status === filter.status ? "page" : undefined}
          className={cn(
            "flex items-baseline gap-1.5 rounded-control border px-3 py-2 text-control",
            view.status === filter.status
              ? "border-primary bg-selected font-medium text-primary-text hover:text-primary-text"
              : "border-line-field bg-card text-ink hover:border-line-strong hover:bg-hover hover:text-ink",
          )}
        >
          {view.label}
          <span className="text-xs opacity-65">{counts[view.status]}</span>
        </Link>
      ))}
    </nav>
  );
}

function Filters({ filter, city, country, onChange }: { filter: FreelanceFilter; city: string; country: string; onChange: (change: Partial<FreelanceFilter>) => void }) {
  const [q, setQ] = useState(filter.q);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onChange({ q: q.trim() });
  };
  return (
    <form
      role="search"
      aria-label="Filter freelance"
      onSubmit={submit}
      className="grid grid-cols-1 items-end gap-4 rounded-panel border border-line-card bg-card p-6 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr]"
    >
      <Input label="Search" value={q} placeholder="e.g. devops, design, React" onChange={(event) => setQ(event.target.value)} onBlur={() => q.trim() !== filter.q && onChange({ q: q.trim() })} />
      <Select label="Where" value={filter.place} onChange={(event) => onChange({ place: event.target.value as FreelanceFilter["place"] })}>
        <option value="any">Anywhere</option>
        {city && <option value="city">{city}</option>}
        {country && <option value="country">{country}</option>}
        <option value="remote">Remote{country ? `, open to ${country}` : ""}</option>
      </Select>
      <Select label="Type" value={filter.engagement} onChange={(event) => onChange({ engagement: event.target.value as FreelanceFilter["engagement"] })}>
        <option value="">Any engagement</option>
        {FREELANCE_ENGAGEMENTS.map((engagement) => (
          <option key={engagement} value={engagement}>
            {FREELANCE_ENGAGEMENT_LABEL[engagement]}
          </option>
        ))}
      </Select>
      <Select label="Source" value={filter.source} onChange={(event) => onChange({ source: event.target.value as FreelanceFilter["source"] })}>
        <option value="">All sources</option>
        {FREELANCE_SOURCES.map((source) => (
          <option key={source} value={source}>
            {FREELANCE_SOURCE_INFO[source].name}
          </option>
        ))}
      </Select>
      <Select label="Match" value={String(filter.minScore)} onChange={(event) => onChange({ minScore: Number(event.target.value) })}>
        <option value="0">Any</option>
        <option value="50">50 and up</option>
        <option value="70">70 and up</option>
        <option value="85">85 and up</option>
      </Select>
      <Select label="Sort" value={filter.sort} onChange={(event) => onChange({ sort: event.target.value as FreelanceFilter["sort"] })}>
        <option value="match">Best match</option>
        <option value="newest">Newest</option>
      </Select>
    </form>
  );
}

function Empty({ filter }: { filter: FreelanceFilter }) {
  const filtered = filter.q || filter.place !== "any" || filter.source || filter.engagement || filter.minScore > 0;
  return (
    <p className="rounded-panel border border-dashed border-line-strong px-7 py-10 text-center text-sm text-muted">
      {filtered ? "None match these filters. Try fewer." : filter.status === "NEW" ? "Nothing new to look at. The next refresh may bring more." : "None here yet."}
    </p>
  );
}

function FreelanceCard({ gig: initial, aiReady, today }: { gig: FreelanceView; aiReady: boolean; today: string }) {
  const router = useRouter();
  const [gig, setGig] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const info = FREELANCE_SOURCE_INFO[gig.source];
  const posted = postedAgo(gig.postedAt, new Date(today));

  const move = async (status: FreelanceStatusName, message: string) => {
    if (busy) return;
    setBusy(status);
    const before = gig.status;
    const result = toastResult(await setFreelanceStatus({ id: gig.id, status }));
    setBusy(null);
    if (!result.ok) return;
    setGig({ ...gig, status });
    toast(message, {
      action: {
        label: "Undo",
        onClick: () =>
          void setFreelanceStatus({ id: gig.id, status: before }).then((undone) => {
            if (toastResult(undone).ok) router.refresh();
          }),
      },
    });
    router.refresh();
  };

  const remove = async () => {
    setRemoving(false);
    if (toastResult(await removeFreelanceForGood({ id: gig.id })).ok) router.refresh();
  };

  return (
    <article aria-label={gig.title} className="flex flex-col gap-4 rounded-panel border border-line-card bg-card px-6 py-5">
      <div className="flex items-start gap-4">
        <ScoreBadge score={gig.score} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-serif text-section">{gig.title}</h3>
            <span className="rounded-full border border-line-field px-2 py-0.5 text-xs text-muted">{FREELANCE_ENGAGEMENT_LABEL[gig.engagement]}</span>
            <span className="rounded-full border border-line-field px-2 py-0.5 text-xs text-muted">
              {info.name} · {info.kind}
            </span>
          </div>
          {gig.company && <p className="text-sm">{gig.company}</p>}
          <p className="text-meta text-muted">
            {[gig.place, gig.remote && !/remote/i.test(gig.place) ? "Remote" : "", gig.budget, gig.duration, posted].filter(Boolean).join(" · ")}
          </p>
        </div>
      </div>

      {gig.reasons.length > 0 && <p className="text-meta text-muted">{gig.reasons.join(" · ")}</p>}

      {gig.description && <p className="line-clamp-3 text-sm text-pretty text-muted">{gig.description}</p>}

      <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-3.5">
        <a href={gig.url} target="_blank" rel="noreferrer" className={buttonClassName("secondary", "sm")}>
          Open posting
        </a>
        {gig.applicationId ? (
          <Link href={`/applications/${gig.applicationId}`} className={buttonClassName("secondary", "sm")}>
            Open the application
          </Link>
        ) : aiReady ? (
          <Link href={`/new?freelance=${encodeURIComponent(gig.id)}`} className={buttonClassName("primary", "sm")}>
            Start application
          </Link>
        ) : (
          <Link href="/settings?section=ai" className={buttonClassName("secondary", "sm")}>
            Set up AI to draft
          </Link>
        )}
        {gig.status !== "SAVED" && (
          <Button size="sm" variant="secondary" aria-disabled={busy ? true : undefined} onClick={() => void move("SAVED", "Saved.")}>
            Save
          </Button>
        )}
        {gig.status !== "DISMISSED" && (
          <Button size="sm" variant="secondary" aria-disabled={busy ? true : undefined} onClick={() => void move("DISMISSED", "Dismissed.")}>
            Dismiss
          </Button>
        )}
        <Button size="sm" variant="text" onClick={() => setRemoving(true)}>
          Remove for good
        </Button>
      </div>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove this opportunity?"
        description="Refreshes won't bring it back. An application you already started from it stays."
        confirmLabel="Remove"
        onConfirm={() => void remove()}
      />
    </article>
  );
}
