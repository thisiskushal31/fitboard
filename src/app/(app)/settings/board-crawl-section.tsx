"use client";

import { useMemo, useState, useTransition } from "react";

import { toast, toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { BoardCrawlListFilter, BoardCrawlResultView } from "@/lib/job-search/crawl-results";
import { cn } from "@/lib/core/cn";

import { clearAllBoardCrawlResults, clearResolvedBoardCrawlResults, deleteBoardCrawlResult, markBoardCrawlResolved } from "./actions";
import { SettingsSectionIntro } from "./settings-screen";

const FILTERS: { value: BoardCrawlListFilter; label: string }[] = [
  { value: "problems", label: "Problems" },
  { value: "ok", label: "With hits" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

function statusLabel(status: BoardCrawlResultView["status"]): string {
  if (status === "ok") return "OK";
  if (status === "empty") return "No listings";
  return "Error";
}

/** Fixed UTC digits only — Intl locale output can still differ between Node and the browser. */
function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}

/**
 * Settings → Board crawl: latest outcome per catalog careers URL from
 * job-boards.json (search bar / portal API). Stored in the database so you
 * can see which pages fail, what they returned, and clear rows when fixed.
 */
export function BoardCrawlSection({
  initial,
  problemCount,
  storedCount,
}: {
  initial: BoardCrawlResultView[];
  problemCount: number;
  storedCount: number;
}) {
  const [filter, setFilter] = useState<BoardCrawlListFilter>("problems");
  const [rows, setRows] = useState(initial);
  const [totalStored, setTotalStored] = useState(storedCount);
  const [pending, startTransition] = useTransition();
  const [confirmClear, setConfirmClear] = useState<"resolved" | "all" | null>(null);

  const visible = useMemo(() => {
    if (filter === "problems") return rows.filter((row) => !row.resolvedAt && (row.status === "empty" || row.status === "error"));
    if (filter === "ok") return rows.filter((row) => row.status === "ok");
    if (filter === "resolved") return rows.filter((row) => row.resolvedAt);
    return rows;
  }, [filter, rows]);

  const removeLocal = (id: string) => {
    setRows((current) => current.filter((row) => row.id !== id));
    setTotalStored((count) => Math.max(0, count - 1));
  };
  const resolveLocal = (id: string) =>
    setRows((current) => current.map((row) => (row.id === id ? { ...row, resolvedAt: new Date().toISOString() } : row)));

  const onResolve = (id: string) => {
    startTransition(async () => {
      const result = toastResult(await markBoardCrawlResolved({ id }));
      if (result.ok) resolveLocal(id);
    });
  };

  const onDelete = (id: string) => {
    startTransition(async () => {
      const result = toastResult(await deleteBoardCrawlResult({ id }));
      if (result.ok) removeLocal(id);
    });
  };

  const onClear = (kind: "resolved" | "all") => {
    startTransition(async () => {
      const result =
        kind === "resolved" ? toastResult(await clearResolvedBoardCrawlResults({})) : toastResult(await clearAllBoardCrawlResults({}));
      if (!result.ok) return;
      setRows((current) => {
        const next = kind === "resolved" ? current.filter((row) => !row.resolvedAt) : [];
        setTotalStored(next.length);
        return next;
      });
      setConfirmClear(null);
      toast(kind === "resolved" ? "Cleared resolved crawl rows." : "Cleared all crawl diagnostics.");
    });
  };

  return (
    <>
      <SettingsSectionIntro title="Board crawl">
        After Find jobs or the job agent opens a careers URL from{" "}
        <code className="font-mono text-label">job-boards.json</code>, the latest result is stored here. Hits go to{" "}
        <span className="text-ink">With hits</span> automatically. Portals that answer with no matching roles are auto-moved to{" "}
        <span className="text-ink">Resolved</span>. Only broken pages stay under Problems — mark those resolved by hand if you have fixed
        the URL, or delete the row. Stale URLs removed from the catalog are dropped from this list.
      </SettingsSectionIntro>

      <Card className="flex flex-col gap-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <SegmentedControl
            aria-label="Crawl result filter"
            value={filter}
            onValueChange={(value) => setFilter(value as BoardCrawlListFilter)}
            options={FILTERS.map((entry) => ({ value: entry.value, label: entry.label }))}
          />
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="secondary" size="sm" disabled={pending || !rows.some((row) => row.resolvedAt)} onClick={() => setConfirmClear("resolved")}>
              Clear resolved
            </Button>
            <Button type="button" variant="secondary" size="sm" disabled={pending || rows.length === 0} onClick={() => setConfirmClear("all")}>
              Clear all
            </Button>
          </div>
        </div>
        <p className="text-sm text-muted">
          {problemCount === 0
            ? "No open problems from the latest crawls."
            : `${problemCount} open ${problemCount === 1 ? "problem" : "problems"} (empty results or errors).`}{" "}
          Showing {visible.length} in this filter · {totalStored} stored {totalStored === 1 ? "page" : "pages"} in the database
          {rows.length < totalStored ? ` (${rows.length} loaded)` : ""}.
        </p>
      </Card>

      {visible.length === 0 ? (
        <Card className="p-5 text-sm text-muted">Nothing in this filter yet. Run Find jobs or the job agent on Public boards to fill it.</Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {visible.map((row) => (
            <li key={row.id}>
              <Card className="flex flex-col gap-3 p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium text-ink">{row.company || "Catalog board"}</span>
                      <span
                        className={cn(
                          "rounded-control px-2 py-0.5 text-meta",
                          row.status === "ok" && "bg-selected text-ink",
                          row.status === "empty" && "bg-hover text-muted",
                          row.status === "error" && "bg-danger-surface text-danger",
                        )}
                      >
                        {statusLabel(row.status)}
                        {row.status === "ok" ? ` · ${row.hitCount}` : ""}
                      </span>
                      {row.resolvedAt ? <span className="text-meta text-muted">Resolved</span> : null}
                    </div>
                    <a href={row.url} target="_blank" rel="noreferrer" className="mt-1 block truncate text-sm text-muted underline-offset-2 hover:underline">
                      {row.url}
                    </a>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {!row.resolvedAt && row.status !== "ok" ? (
                      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => onResolve(row.id)}>
                        Mark resolved
                      </Button>
                    ) : null}
                    <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => onDelete(row.id)}>
                      Delete
                    </Button>
                  </div>
                </div>
                <p className="text-sm text-pretty text-ink">{row.detail || "No detail recorded."}</p>
                {row.samples.length > 0 ? (
                  <ul className="list-disc pl-5 text-sm text-muted">
                    {row.samples.map((sample, index) => (
                      <li key={`${row.id}-${index}`}>{sample}</li>
                    ))}
                  </ul>
                ) : null}
                <p className="text-meta text-muted" suppressHydrationWarning>
                  Searched “{row.keywords || "—"}”
                  {row.place ? ` · ${row.place}` : ""}
                  {row.country ? ` · ${row.country}` : ""} · via {row.method} · {when(row.crawledAt)}
                  {row.durationMs > 0 ? ` · ${row.durationMs} ms` : ""}
                </p>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmClear !== null}
        onOpenChange={(open) => !open && setConfirmClear(null)}
        title={confirmClear === "all" ? "Clear all crawl diagnostics?" : "Clear resolved crawl rows?"}
        description={
          confirmClear === "all"
            ? "Removes every stored board crawl result. New ones appear again after the next Public boards search."
            : "Removes only rows you marked as resolved."
        }
        confirmLabel="Clear"
        onConfirm={() => confirmClear && onClear(confirmClear)}
      />
    </>
  );
}
