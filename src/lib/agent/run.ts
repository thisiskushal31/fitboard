import "server-only";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { AgentCandidateStatus } from "@/generated/prisma/enums";
import { AiError } from "@/lib/ai/errors";
import { searchPostings } from "@/lib/job-search";
import { credentialsFor, loadJobSearchConfig, requestContext } from "@/lib/job-search/config";
import { JobSearchError } from "@/lib/job-search/errors";
import { postingKey, type FoundPosting, type SearchPage, type SearchQuery } from "@/lib/job-search/search";
import { startJob, type JobContext } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/core/log";
import { saveScore } from "@/lib/postings/posting-scores";
import { postingStates } from "@/lib/postings/postings";
import { prisma } from "@/lib/core/prisma";
import { loadProfile } from "@/lib/profile/profile-data";
import { loadPostingScorer, scoringProblem } from "@/lib/scoring";
import { loadSettings } from "@/lib/settings/settings-data";

import { agentDedupeKey, candidateData } from "./candidates";
import { agentDraftJob, draftJobKey } from "./draft";
import { recordRunEnd, recordRunStart, runLimitProblem } from "./runs";

// One run of the job agent: walk the search results in order, skip
// postings already scored or kept in Find jobs, and score the next
// unread batch up to agentMaxScores. Later runs continue further down
// the list. It never sends anything.

export const agentScanResultSchema = z.object({
  /** Postings the source returned. */
  found: z.number().int().min(0),
  /** Of those, the ones not seen before. */
  fresh: z.number().int().min(0),
  scored: z.number().int().min(0),
  drafted: z.number().int().min(0),
  /** Found but seen before: saved, dismissed or applied for in Find jobs, or a candidate already. */
  skipped: z.number().int().min(0),
  /** What to tell the user. */
  message: z.string(),
});
export type AgentScanResult = z.infer<typeof agentScanResultSchema>;

const stopped = (message: string): AgentScanResult => ({ found: 0, fresh: 0, scored: 0, drafted: 0, skipped: 0, message });

/** Whether a search is complete enough to run: keywords and a country. */
export const agentQueryReady = (query: SearchQuery) => Boolean(query.keywords.trim() && query.country);

/** Why the agent can't run at all, in words, or null when it's set up. */
export async function agentSetupProblem(query: SearchQuery): Promise<string | null> {
  if (!query.keywords.trim()) return "Add what to look for in Settings → Job agent first.";
  if (!query.country) return "Choose a country for the search in Settings → Job agent first.";
  // Scoring is what a run does; drafts ask the AI provider when there are any.
  const scoring = await scoringProblem();
  if (scoring) return scoring;
  const config = await loadJobSearchConfig();
  if (!config.source) return "Choose a job source in Settings → Job search first.";
  // It searches on its own, which the BA's terms forbid most clearly.
  if (config.source === "ARBEITSAGENTUR") return "The job agent doesn't search the Bundesagentur für Arbeit. Choose Boardsearch, Adzuna or FreeHire in Settings → Job search for it.";
  try {
    credentialsFor(config, config.source);
  } catch (error) {
    if (error instanceof JobSearchError) return error.message;
    throw error;
  }
  return null;
}

/** The postings from a page that are new to the agent: not saved, dismissed or applied for, and not a candidate already. */
export async function newPostings(postings: readonly FoundPosting[]): Promise<FoundPosting[]> {
  const states = await postingStates(postings);
  const unseen = postings.filter((posting) => {
    const state = states.get(postingKey(posting));
    return !state?.saved && !state?.dismissed && !state?.applicationId;
  });
  const keys = unseen.map(agentDedupeKey);
  const known = await prisma.agentCandidate.findMany({
    where: { OR: [...unseen.map(({ source, externalId }) => ({ source, externalId })), { dedupeKey: { in: keys } }] },
    select: { source: true, externalId: true, dedupeKey: true },
  });
  const seen = new Set(known.flatMap((candidate) => [postingKey(candidate), candidate.dedupeKey]));
  // The same job twice in one page counts once too.
  return unseen.filter((posting, index) => {
    const fresh = !seen.has(postingKey(posting)) && !seen.has(keys[index]);
    seen.add(keys[index]);
    return fresh;
  });
}

/** How many result pages one run may walk while skipping already-seen rows. */
function agentPageMax(source: string): number {
  // Public boards page a cached crawl in memory; paid sources cost a request each.
  return source === "PUBLIC_BOARDS" ? 100 : 25;
}

/**
 * One run: walk search pages in order until there are agentMaxScores unread
 * postings (or the list ends), then score that batch in list order. Each is
 * kept as a candidate so it is not scored again; one below agentMinScore
 * stays out of the queue. With auto-draft on, the best of them get a draft
 * each, up to agentMaxDrafts. A scheduled run does nothing while the agent
 * is off.
 */
export async function runAgentScan({ manual }: { manual: boolean }, context: JobContext, now = new Date()): Promise<AgentScanResult> {
  const settings = await loadSettings();
  if (!settings.agentEnabled && !manual) return stopped("The job agent is off.");
  const setup = await agentSetupProblem(settings.agentQuery);
  if (setup) return stopped(setup);
  const limit = runLimitProblem(settings.agentRuns, now, { manual: false });
  if (limit) return stopped(limit);

  const run = await recordRunStart(now, manual);
  const finish = async (result: AgentScanResult) => {
    await recordRunEnd(run, result.message);
    return result;
  };

  await context.step("Searching for new postings");
  const config = await loadJobSearchConfig();
  const source = config.source!;
  const postings: FoundPosting[] = [];
  const seen = new Set<string>();
  let next: string | null = null;
  let searchError: string | null = null;
  const pageMax = agentPageMax(source);
  try {
    for (let page = 0; page < pageMax; page++) {
      if (context.signal.aborted) break;
      const result: SearchPage = await searchPostings(source, credentialsFor(config, source), settings.agentQuery, next, requestContext(source));
      if (result.postings.length === 0) break;
      for (const posting of result.postings) {
        const key = postingKey(posting);
        if (seen.has(key)) continue;
        seen.add(key);
        postings.push(posting);
      }
      next = result.next;
      if ((await newPostings(postings)).length >= settings.agentMaxScores) break;
      if (!next) break;
    }
  } catch (error) {
    if (!(error instanceof JobSearchError)) throw error;
    // A later page failed: still score unread rows already collected.
    if (postings.length === 0) return finish(stopped(error.message));
    searchError = error.message;
  }

  const fresh = await newPostings(postings);
  const counts = { found: postings.length, fresh: fresh.length, skipped: postings.length - fresh.length, drafted: 0 };
  if (fresh.length === 0) {
    if (searchError) return finish(stopped(searchError));
    return finish({ ...counts, scored: 0, message: postings.length === 0 ? "The search found no postings this time." : "No new postings this time." });
  }

  // Search order: already-seen rows were skipped above, so this is the next unread batch.
  const toScore = fresh.slice(0, settings.agentMaxScores);
  await context.step(`Scoring ${toScore.length} ${toScore.length === 1 ? "posting" : "postings"}`);
  const [score, profile] = await Promise.all([loadPostingScorer(), loadProfile()]);
  let scored = 0;
  let queued = 0;
  const kept: string[] = [];
  let problem: string | null = null;
  for (const posting of toScore) {
    if (context.signal.aborted) break;
    try {
      const { data, scoredWith } = await score(posting, profile, context.signal);
      const candidate = await prisma.agentCandidate.create({ data: candidateData(posting, data), select: { id: true } });
      // Find jobs shows it too.
      await saveScore(posting, data, scoredWith);
      kept.push(candidate.id);
      scored += 1;
      if (data.score >= settings.agentMinScore) queued += 1;
    } catch (error) {
      // Another run kept it first: it's seen either way.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      // One posting that fails doesn't stop the rest.
      if (error instanceof AiError) problem = error.message;
      else if (!context.signal.aborted) logServerError("job agent scoring", error);
    }
  }

  // Auto-draft (off by default): the best of this run's, one job each.
  let drafted = 0;
  if (settings.agentAutoDraft && settings.agentMaxDrafts > 0 && !context.signal.aborted) {
    const best = await prisma.agentCandidate.findMany({
      where: { id: { in: kept }, status: AgentCandidateStatus.SCORED, score: { gte: settings.agentMinScore } },
      orderBy: { score: "desc" },
      take: settings.agentMaxDrafts,
      select: { id: true },
    });
    for (const { id } of best) await startJob(agentDraftJob, { candidateId: id }, { key: draftJobKey(id) });
    drafted = best.length;
  }

  const waiting = `${queued} new ${queued === 1 ? "posting is" : "postings are"} waiting for a look.`;
  const message =
    scored === 0
      ? (problem ?? "No postings could be scored this time.")
      : queued === 0
        ? `Scored ${scored} new ${scored === 1 ? "posting" : "postings"}; none reached your minimum score of ${settings.agentMinScore}.`
        : drafted > 0
          ? `${waiting} Preparing ${drafted === 1 ? "a draft for the best one" : `drafts for the best ${drafted}`}.`
          : waiting;
  return finish({ ...counts, scored, drafted, message });
}
