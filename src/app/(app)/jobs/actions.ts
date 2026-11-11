"use server";

import { z } from "zod";

import { action, ActionError } from "@/lib/core/action";
import { isAiUsable } from "@/lib/ai/config";
import { handOffFoundPosting, handsOffToClaude } from "@/lib/connector/handoff";
import { loadJobSearchConfig } from "@/lib/job-search/config";
import { fullText } from "@/lib/job-search/find";
import { countLayoffRows, syncLayoffsFromUrl } from "@/lib/job-search/layoffs";
import { loadPostingIntel as postingIntel } from "@/lib/job-search/posting-intel";
import { marketSalaryForRole } from "@/lib/job-search/salary-market";
import { foundPostingSchema, JOB_SOURCES, searchQuerySchema } from "@/lib/job-search/search";
import { findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { scoreJobKey, scorePostingJob } from "@/lib/jobs/score-posting";
import { removeSearch, runSearch, showMoreFor } from "@/lib/postings/posting-searches";
import { dismissPosting, savePosting, storePosting, unmarkPosting } from "@/lib/postings/postings";
import { scoringProblem } from "@/lib/scoring";
import { loadScoringConfig } from "@/lib/scoring/config";
import { saveSettings } from "@/lib/settings/settings-data";

// Find jobs. Each search is kept with what it found.
// Postings come back from the screen as the search gave them, checked
// against the posting shape.

const postingRef = z.object({ source: z.enum(JOB_SOURCES), externalId: z.string().min(1).max(500) });
const searchId = z.string().min(1).max(100);

/** "I understand" under the Bundesagentur für Arbeit's note, for a BA choice made before it, or by FITBOARD_JOBS_SOURCE. */
export const acceptArbeitsagenturNote = action(z.object({}), async () => {
  const { arbeitsagentur } = await loadJobSearchConfig();
  if (!arbeitsagentur.offered) throw new ActionError("The Bundesagentur für Arbeit isn't offered on this server.");
  await saveSettings({ arbeitsagenturAcceptedAt: new Date().toISOString() });
  return null;
});

/** "Search": asks the chosen source and keeps the search with what it found; gives its id, or what went wrong. */
export const runJobSearch = action(z.object({ query: searchQuerySchema }), ({ query }) => runSearch(query));

/** "Show more": the next page, added to the kept search. */
export const showMorePostings = action(z.object({ searchId }), ({ searchId }) => showMoreFor(searchId));

/** Removes a kept search and what it found; saved postings stay. */
export const removeJobSearch = action(z.object({ id: searchId }), async ({ id }, { toast }) => {
  await removeSearch(id);
  toast("Search removed. Saved postings from it stay in Saved.");
  return null;
});

/** The whole text of a posting the search only gave the start of; null when it can't be had. */
export const loadFullText = action(z.object({ posting: foundPostingSchema }), async ({ posting }) => ({ text: await fullText(posting) }));

export const savePostingForLater = action(z.object({ posting: foundPostingSchema }), async ({ posting }, { toast }) => {
  const saved = await savePosting(posting);
  toast("Saved for later.");
  return { postingId: saved.id };
});

export const unsavePosting = action(postingRef, async (ref, { toast }) => {
  await unmarkPosting(ref, "saved");
  toast("Removed from Saved.");
  return null;
});

/** Dismiss: out of this and later searches. Says whether it was saved, so Undo can put it back. */
export const dismissFoundPosting = action(z.object({ posting: foundPostingSchema }), ({ posting }) => dismissPosting(posting));

/**
 * "Start application": keeps the posting with its whole text when it
 * can be had, for New application to open from its id.
 */
export const startApplicationFrom = action(z.object({ posting: foundPostingSchema }), async ({ posting }) => {
  const text = await fullText(posting);
  const stored = await storePosting(text ? { ...posting, description: text, complete: true } : posting);
  return { postingId: stored.id };
});

/** Brings a dismissed posting back, into Saved again when it was there (Undo). */
export const restorePosting = action(postingRef.extend({ saved: z.boolean() }), async ({ saved, ...ref }) => {
  await unmarkPosting(ref, "dismissed", { saved });
  return null;
});

/**
 * "Score": how well a posting fits the profile, in the background; a
 * scoring under way is followed, not started again. With the Claude connector
 * on and no AI model of Fitboard's own, a Claude chat scores it instead,
 * unless Settings → Scoring chose Jev.
 */
export const startScoringPosting = action(z.object({ posting: foundPostingSchema }), async ({ posting }): Promise<{ jobId: string } | { handoff: string }> => {
  const scoring = await loadScoringConfig();
  if (scoring.scorer === "AI" && (await handsOffToClaude(await isAiUsable()))) return { handoff: await handOffFoundPosting(posting, "score") };
  const problem = await scoringProblem(scoring);
  if (problem) throw new ActionError(problem);
  const key = scoreJobKey(posting);
  const [unfinished] = await findUnfinishedJobs(key);
  return { jobId: unfinished?.id ?? (await startJob(scorePostingJob, { posting }, { key })) };
});

/** Offer salary, Adzuna market band, and company layoffs for a posting. */
export const loadPostingIntel = action(
  z.object({
    company: z.string().max(300),
    title: z.string().max(500),
    place: z.string().max(300).optional(),
    country: z.string().max(32).optional(),
    salary: z.string().max(200).optional(),
    description: z.string().max(4_000).optional(),
  }),
  ({ company, title, place, country, salary, description }) =>
    postingIntel({ company, title, place, country, salary, description }),
);

/** Market median for the search keywords (Pay compare reference line). */
export const loadMarketSalary = action(
  z.object({
    title: z.string().min(1).max(500),
    place: z.string().max(300).optional(),
    country: z.string().min(2).max(8),
  }),
  async ({ title, place, country }) => {
    const market = await marketSalaryForRole({ title, place, country });
    return market
      ? {
          median: market.median,
          currency: market.currency,
          label: market.label,
          source: market.source,
          sourceLabel: market.sourceLabel,
          attributionUrl: market.attributionUrl,
        }
      : { median: null, currency: null, label: null, source: null, sourceLabel: null, attributionUrl: null };
  },
);

/** Pull layoff events from Layoffs.fyi + WARN + Layoff Map (skip sources that fail). */
export const syncLayoffData = action(z.object({}), async () => {
  try {
    const result = await syncLayoffsFromUrl();
    return result;
  } catch (error) {
    throw new ActionError(error instanceof Error ? error.message : "Could not refresh layoff data.");
  }
});

/** How many layoff rows are stored (for empty-state hints). */
export const layoffDataCount = action(z.object({}), async () => ({ count: await countLayoffRows() }));
