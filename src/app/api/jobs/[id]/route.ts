import { NextResponse } from "next/server";

import { getJob } from "@/lib/jobs/runner";
import { route } from "@/lib/core/route";

/** A job's state, for pages that can't use the event stream (polling fallback). */
export const GET = route<RouteContext<"/api/jobs/[id]">>(async (_request, { params }) => {
  const job = await getJob((await params).id);
  if (!job) return NextResponse.json({ error: "That job doesn't exist." }, { status: 404 });
  return NextResponse.json(job);
});
