"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { JobView } from "@/lib/jobs/runner";

const POLL_MS = 2500;
const finished = (job: JobView) => job.status === "DONE" || job.status === "FAILED";

const sameJob = <R,>(a: JobView<R> | null | undefined, b: JobView<R>) =>
  !!a && a.status === b.status && a.step === b.step && a.error === b.error && a.result === b.result;

/**
 * Follows a background job: live through Server-Sent Events, or by
 * polling when the stream can't be used. Pass the id kept in the URL or on
 * the record, so a reloaded page picks the job up where it is. Bump
 * `revision` after a Retry to follow the job's new run. `onChange` hears
 * every update, e.g. to move on once the job is done.
 */
export function useJob<R = unknown>(
  id: string | null,
  revision = 0,
  onChange?: (job: JobView<R>) => void,
): JobView<R> | null {
  const [state, setState] = useState<{ id: string; job: JobView<R> } | null>(null);
  const listener = useRef(onChange);
  const latest = useRef<JobView<R> | null>(null);
  useLayoutEffect(() => {
    listener.current = onChange;
  });

  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let settled = false;
    let polling = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    latest.current = null;

    const update = (job: JobView<R>) => {
      if (stopped) return;
      if (sameJob(latest.current, job)) {
        if (finished(job)) settled = true;
        return;
      }
      latest.current = job;
      setState({ id, job });
      listener.current?.(job);
      if (finished(job)) settled = true;
    };

    const poll = async () => {
      if (stopped || settled) {
        polling = false;
        return;
      }
      try {
        const response = await fetch(`/api/jobs/${id}`);
        if (response.status === 404) {
          // Job was deleted or never existed — stop asking.
          settled = true;
          polling = false;
          return;
        }
        if (response.ok) {
          const job = (await response.json()) as JobView<R>;
          update(job);
          if (finished(job)) {
            polling = false;
            return;
          }
        }
      } catch {
        // Offline for a moment: try again.
      }
      if (!stopped && !settled) timer = setTimeout(() => void poll(), POLL_MS);
      else polling = false;
    };

    const startPolling = () => {
      // EventSource can fire onerror more than once around close(); only one poll loop.
      if (stopped || settled || polling) return;
      polling = true;
      void poll();
    };

    const source = new EventSource(`/api/jobs/${id}/events`);
    source.onmessage = (event: MessageEvent<string>) => {
      const job = JSON.parse(event.data) as JobView<R>;
      update(job);
      if (finished(job)) {
        source.onerror = null;
        source.close();
      }
    };
    // Some proxies break event streams: fall back to asking now and then.
    // Closing a finished stream also fires onerror — don't start polling then.
    source.onerror = () => {
      source.onerror = null;
      source.onmessage = null;
      source.close();
      startPolling();
    };

    return () => {
      stopped = true;
      source.onerror = null;
      source.onmessage = null;
      source.close();
      clearTimeout(timer);
    };
  }, [id, revision]);

  return state && state.id === id ? state.job : null;
}
