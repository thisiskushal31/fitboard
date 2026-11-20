import { NextResponse } from "next/server";

import { getJob, isFinished, subscribeJob, type JobView } from "@/lib/jobs/runner";
import { route } from "@/lib/core/route";

/** Keeps proxies from closing a quiet stream while a local model thinks. */
const HEARTBEAT_MS = 15_000;

/**
 * A job's progress as Server-Sent Events: its state now, then after
 * every change, until it's done or failed.
 */
export const GET = route<RouteContext<"/api/jobs/[id]/events">>(async (request, { params }) => {
  const { id } = await params;
  if (!(await getJob(id))) return NextResponse.json({ error: "That job doesn't exist." }, { status: 404 });
  const encoder = new TextEncoder();
  let stop = () => {};

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let unsubscribe = () => {};
      const write = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // Client gone (refresh, navigate away) — stop without throwing into Next.
          stop();
        }
      };
      const heartbeat = setInterval(() => write(": still working\n\n"), HEARTBEAT_MS);
      stop = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // Already closed by the runtime.
        }
      };
      const send = (job: JobView) => {
        write(`data: ${JSON.stringify(job)}\n\n`);
        if (isFinished(job)) stop();
      };
      // If the client reconnects before close() sticks, wait — don't hammer.
      write("retry: 5000\n\n");
      // Listen before reading, so a change in between isn't missed.
      unsubscribe = subscribeJob(id, send);
      request.signal.addEventListener("abort", () => stop(), { once: true });
      const job = await getJob(id);
      if (job) send(job);
      else stop();
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // Tells nginx (CapRover) not to buffer the stream.
      "x-accel-buffering": "no",
    },
  });
});
