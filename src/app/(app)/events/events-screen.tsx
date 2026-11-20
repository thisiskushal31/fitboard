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
import { formatCalendarDate, formatDateTime } from "@/lib/core/dates";
import { eventLocationLabel } from "@/lib/events/place";
import {
  EVENT_FORMAT_LABEL,
  EVENT_FORMATS,
  EVENT_SOURCE_INFO,
  EVENT_SOURCES,
  eventFilterHref,
  type EventFilter,
  type EventFormatName,
  type EventsRefresh,
  type EventStatusName,
  type EventView,
} from "@/lib/events/types";

import { refreshEventsNow, removeEventForGood, setEventStatus } from "./actions";

export type EventsScreenProps = {
  filter: EventFilter;
  list: { events: EventView[]; total: number; counts: Record<EventStatusName, number> };
  lastRefresh: EventsRefresh | null;
  refreshJobId: string | null;
  city: string;
  country: string;
  today: string;
  timeZone: string;
};

const VIEWS: { status: EventStatusName; label: string }[] = [
  { status: "NEW", label: "To look at" },
  { status: "SAVED", label: "Saved" },
  { status: "DISMISSED", label: "Dismissed" },
];

const PROXIMITY_LABEL = ["Near you", "In your country", "Virtual", "Further away"] as const;

/**
 * The Events screen: tech conferences and events from public sources,
 * ranked by place proximity then profile fit. Fitboard never registers.
 */
export function EventsScreen({ filter, list, lastRefresh, refreshJobId, city, country, today, timeZone }: EventsScreenProps) {
  const router = useRouter();
  const [jobId, setJobId] = useState(refreshJobId);
  const [starting, startTransition] = useTransition();

  const job = useJob<EventsRefresh>(jobId, 0, (update) => {
    if (update.status !== "DONE" && update.status !== "FAILED") return;
    setJobId(null);
    if (update.status === "FAILED") return toast(update.error ?? "The refresh didn't finish. Try again.");
    const added = update.result?.added ?? 0;
    toast(added > 0 ? `Found ${added} new ${added === 1 ? "event" : "events"}.` : "No new events this time.");
    router.refresh();
  });
  const refreshing = Boolean(jobId) && (!job || job.status === "QUEUED" || job.status === "RUNNING");

  const refresh = () =>
    startTransition(async () => {
      const result = toastResult(await refreshEventsNow({}));
      if (result.ok) setJobId(result.data.jobId);
    });

  const go = (change: Partial<EventFilter>) => router.replace(eventFilterHref({ ...filter, ...change }), { scroll: false });

  return (
    <>
      <PageHeader
        title="Events"
        description="Tech events worldwide, ranked by how near they are to you and how well they fit your skills. You open each listing yourself — Fitboard never registers for you."
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
            {list.events.length === 0 ? (
              <Empty filter={filter} />
            ) : (
              <>
                <p className="text-meta text-muted">
                  {list.total > list.events.length
                    ? `The nearest ${list.events.length} of ${list.total}`
                    : `${list.total} ${list.total === 1 ? "event" : "events"}`}
                  {filter.sort === "nearby" ? ", nearest first." : filter.sort === "soon" ? ", soonest first." : ", best match first."}
                </p>
                <ul className="flex flex-col gap-3">
                  {list.events.map((event) => (
                    <li key={`${event.id}:${event.status}:${event.score}:${event.proximity}`}>
                      <EventCard event={event} />
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
  lastRefresh: EventsRefresh | null;
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
          Press <strong>Refresh</strong> to look for tech events. Fitboard reads TechConf.Directory, TechMeetups, confs.tech, and Meetup group calendars
          (public feeds only), then ranks what it finds by your profile place and skills.
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
          .map((source) => `${EVENT_SOURCE_INFO[source.source].name} ${source.found}`)
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

function ViewTabs({ filter, counts }: { filter: EventFilter; counts: Record<EventStatusName, number> }) {
  return (
    <nav aria-label="Events views" className="flex flex-wrap gap-1.5">
      {VIEWS.map((view) => (
        <Link
          key={view.status}
          href={eventFilterHref({ ...filter, status: view.status })}
          aria-current={view.status === filter.status ? "page" : undefined}
          className={cn(
            "flex items-baseline gap-1.5 rounded-control border px-3 py-2 text-control",
            view.status === filter.status
              ? "border-primary bg-selected font-medium text-primary-text hover:text-primary-text"
              : "border-line-field bg-card text-ink hover:border-line-strong hover:bg-hover hover:text-ink",
          )}
        >
          {view.label}
          <span className="text-meta text-muted">{counts[view.status]}</span>
        </Link>
      ))}
    </nav>
  );
}

function Filters({ filter, city, country, onChange }: { filter: EventFilter; city: string; country: string; onChange: (change: Partial<EventFilter>) => void }) {
  const [q, setQ] = useState(filter.q);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onChange({ q: q.trim() });
  };
  return (
    <form
      role="search"
      aria-label="Filter events"
      onSubmit={submit}
      className="grid grid-cols-1 items-end gap-4 rounded-panel border border-line-card bg-card p-6 sm:grid-cols-2 lg:grid-cols-[2fr_1fr_1fr_1fr_1fr_1fr]"
    >
      <Input label="Search" value={q} placeholder="e.g. React, AI, design" onChange={(event) => setQ(event.target.value)} onBlur={() => q.trim() !== filter.q && onChange({ q: q.trim() })} />
      <Select label="Where" value={filter.place} onChange={(event) => onChange({ place: event.target.value as EventFilter["place"] })}>
        <option value="any">Anywhere</option>
        {city && <option value="city">{city}</option>}
        {country && <option value="country">{country}</option>}
        <option value="remote">Virtual{country ? ` / open to ${country}` : ""}</option>
      </Select>
      <Select label="Format" value={filter.format} onChange={(event) => onChange({ format: event.target.value as EventFilter["format"] })}>
        <option value="">Any format</option>
        {EVENT_FORMATS.filter((format) => format !== "UNKNOWN").map((format) => (
          <option key={format} value={format}>
            {EVENT_FORMAT_LABEL[format]}
          </option>
        ))}
      </Select>
      <Select label="Source" value={filter.source} onChange={(event) => onChange({ source: event.target.value as EventFilter["source"] })}>
        <option value="">All sources</option>
        {EVENT_SOURCES.map((source) => (
          <option key={source} value={source}>
            {EVENT_SOURCE_INFO[source].name}
          </option>
        ))}
      </Select>
      <Select label="Match" value={String(filter.minScore)} onChange={(event) => onChange({ minScore: Number(event.target.value) })}>
        <option value="0">Any</option>
        <option value="50">50 and up</option>
        <option value="70">70 and up</option>
        <option value="85">85 and up</option>
      </Select>
      <Select label="Sort" value={filter.sort} onChange={(event) => onChange({ sort: event.target.value as EventFilter["sort"] })}>
        <option value="nearby">Nearest</option>
        <option value="soon">Soonest</option>
        <option value="match">Best match</option>
      </Select>
    </form>
  );
}

function Empty({ filter }: { filter: EventFilter }) {
  const filtered = filter.q || filter.place !== "any" || filter.source || filter.format || filter.minScore > 0;
  return (
    <p className="rounded-panel border border-dashed border-line-strong px-7 py-10 text-center text-sm text-muted">
      {filtered ? "None match these filters. Try fewer." : filter.status === "NEW" ? "Nothing new to look at. The next refresh may bring more." : "None here yet."}
    </p>
  );
}

function dateRange(event: EventView): string {
  if (!event.startsAt) return "";
  const start = formatCalendarDate(new Date(event.startsAt));
  if (!event.endsAt || event.endsAt.slice(0, 10) === event.startsAt.slice(0, 10)) return start;
  return `${start} – ${formatCalendarDate(new Date(event.endsAt))}`;
}

function EventCard({ event: initial }: { event: EventView }) {
  const router = useRouter();
  const [event, setEvent] = useState(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const info = EVENT_SOURCE_INFO[event.source];
  const when = dateRange(event);
  const proximity = PROXIMITY_LABEL[Math.min(3, Math.max(0, event.proximity))] ?? PROXIMITY_LABEL[3];

  const move = async (status: EventStatusName, message: string) => {
    if (busy) return;
    setBusy(status);
    const before = event.status;
    const result = toastResult(await setEventStatus({ id: event.id, status }));
    setBusy(null);
    if (!result.ok) return;
    setEvent({ ...event, status });
    toast(message, {
      action: {
        label: "Undo",
        onClick: () =>
          void setEventStatus({ id: event.id, status: before }).then((undone) => {
            if (toastResult(undone).ok) router.refresh();
          }),
      },
    });
    router.refresh();
  };

  const remove = async () => {
    setRemoving(false);
    if (toastResult(await removeEventForGood({ id: event.id })).ok) router.refresh();
  };

  return (
    <article aria-label={event.title} className="flex flex-col gap-4 rounded-panel border border-line-card bg-card px-6 py-5">
      <div className="flex items-start gap-4">
        <ScoreBadge score={event.score} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h3 className="font-serif text-section">{event.title}</h3>
            <span className="rounded-full border border-line-field px-2 py-0.5 text-xs text-muted">{EVENT_FORMAT_LABEL[event.format as EventFormatName]}</span>
            <span className="rounded-full border border-line-field px-2 py-0.5 text-xs text-muted">
              {info.name} · {proximity}
            </span>
          </div>
          <p className="text-meta text-muted">{[when, eventLocationLabel(event)].filter(Boolean).join(" · ")}</p>
        </div>
      </div>

      {event.reasons.length > 0 && <p className="text-meta text-muted">{event.reasons.join(" · ")}</p>}

      {event.summary && <p className="line-clamp-3 text-sm text-pretty text-muted">{event.summary}</p>}

      {(event.speakers.length > 0 || event.ticketPrice || event.audience || event.attendance != null) && (
        <dl className="grid gap-1 text-meta text-muted sm:grid-cols-2">
          {event.speakers.length > 0 && (
            <div>
              <dt className="inline font-medium text-ink">Speakers: </dt>
              <dd className="inline">{event.speakers.join(", ")}</dd>
            </div>
          )}
          {event.ticketPrice && (
            <div>
              <dt className="inline font-medium text-ink">Tickets: </dt>
              <dd className="inline">{event.ticketPrice}</dd>
            </div>
          )}
          {event.audience && (
            <div>
              <dt className="inline font-medium text-ink">Audience: </dt>
              <dd className="inline">{event.audience}</dd>
            </div>
          )}
          {event.attendance != null && (
            <div>
              <dt className="inline font-medium text-ink">Attendance: </dt>
              <dd className="inline">~{event.attendance.toLocaleString()}</dd>
            </div>
          )}
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-2.5 border-t border-line pt-3.5">
        <a href={event.url} target="_blank" rel="noreferrer" className={buttonClassName("primary", "sm")}>
          Open event
        </a>
        {event.status !== "SAVED" && (
          <Button size="sm" variant="secondary" aria-disabled={busy ? true : undefined} onClick={() => void move("SAVED", "Saved.")}>
            Save
          </Button>
        )}
        {event.status !== "DISMISSED" && (
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
        title="Remove this event?"
        description="Refreshes won't bring it back."
        confirmLabel="Remove"
        onConfirm={() => void remove()}
      />
    </article>
  );
}
