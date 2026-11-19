"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/core/action";
import { startEventsRefresh } from "@/lib/events/refresh";
import { removeEvent, updateEvent } from "@/lib/events/store";
import { EVENT_STATUSES } from "@/lib/events/types";

const eventId = z.string().min(1).max(64);
const GONE = "That event is no longer in the list. Refresh the page.";

/** "Refresh": asks public sources again, in the background; returns the job to follow. */
export const refreshEventsNow = action(z.object({}), async () => ({ jobId: await startEventsRefresh() }));

/** Save, Dismiss, and their Undo. */
export const setEventStatus = action(z.object({ id: eventId, status: z.enum(EVENT_STATUSES) }), async ({ id, status }) => {
  const event = await updateEvent(id, { status });
  if (!event) throw new ActionError(GONE);
  return { status: event.status };
});

/** Notes on an event, kept as typed. */
export const saveEventNotes = action(z.object({ id: eventId, notes: z.string().max(5_000) }), async ({ id, notes }) => {
  if (!(await updateEvent(id, { notes }))) throw new ActionError(GONE);
  return null;
});

/** "Remove and don't bring back". */
export const removeEventForGood = action(z.object({ id: eventId }), async ({ id }, { toast }) => {
  if (!(await removeEvent(id))) throw new ActionError(GONE);
  toast("Removed. Refreshes won't bring it back.");
  return null;
});
