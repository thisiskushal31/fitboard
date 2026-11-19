"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/core/action";
import { startFreelanceRefresh } from "@/lib/freelance/refresh";
import { removeFreelance, updateFreelance } from "@/lib/freelance/store";
import { FREELANCE_STATUSES } from "@/lib/freelance/types";

const freelanceId = z.string().min(1).max(64);
const GONE = "That opportunity is no longer in the list. Refresh the page.";

/** "Refresh": asks public sources again, in the background; returns the job to follow. */
export const refreshFreelanceNow = action(z.object({}), async () => ({ jobId: await startFreelanceRefresh() }));

/** Save, Mark as contacted, Dismiss, and their Undo. */
export const setFreelanceStatus = action(z.object({ id: freelanceId, status: z.enum(FREELANCE_STATUSES) }), async ({ id, status }) => {
  const gig = await updateFreelance(id, { status });
  if (!gig) throw new ActionError(GONE);
  return { status: gig.status };
});

/** Notes on an opportunity, kept as typed. */
export const saveFreelanceNotes = action(z.object({ id: freelanceId, notes: z.string().max(5_000) }), async ({ id, notes }) => {
  if (!(await updateFreelance(id, { notes }))) throw new ActionError(GONE);
  return null;
});

/** "Remove and don't bring back". */
export const removeFreelanceForGood = action(z.object({ id: freelanceId }), async ({ id }, { toast }) => {
  if (!(await removeFreelance(id))) throw new ActionError(GONE);
  toast("Removed. Refreshes won't bring it back.");
  return null;
});
