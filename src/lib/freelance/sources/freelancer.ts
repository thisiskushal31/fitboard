import "server-only";

import { getText, settledInBatches, SourceError } from "./http";
import { itemsFromRss, postedIso } from "./rss";
import type { FoundFreelance } from "../types";

// Freelancer.com: public project RSS feeds.

/** Feeds fetched at once. */
const CONCURRENCY = 4;

const FEEDS = [
  "https://www.freelancer.com/rss.xml",
  "https://www.freelancer.com/rss/job_PHP.xml",
  "https://www.freelancer.com/rss/job_Website-Design.xml",
  "https://www.freelancer.com/rss/job_JavaScript.xml",
  "https://www.freelancer.com/rss/job_Python.xml",
] as const;

const BUDGET = /(?:budget|fixed|hourly)[:\s]*\$?[\d,]+(?:\s*[-–]\s*\$?[\d,]+)?(?:\s*\/\s*(?:hr|hour))?/i;

function engagementFrom(blob: string): FoundFreelance["engagement"] {
  if (/\b(temporary|temp|short[-\s]?term)\b/i.test(blob)) return "TEMPORARY";
  if (/\b(hourly|retainer|ongoing)\b/i.test(blob)) return "CONTRACT";
  return "PROJECT";
}

function budgetFrom(blob: string): string {
  const match = blob.match(BUDGET);
  return match?.[0]?.replace(/^(?:budget|fixed|hourly)[:\s]*/i, "").slice(0, 80) ?? "";
}

/** Freelancer.com's public project RSS — clients seeking freelancers. */
export async function fetchFreelancerFreelance(signal?: AbortSignal): Promise<FoundFreelance[]> {
  const results = await settledInBatches(FEEDS, CONCURRENCY, (url) => getText(url, { signal }));
  const jobs: FoundFreelance[] = [];
  const seen = new Set<string>();
  let anyOk = false;
  let lastError: unknown;
  for (const result of results) {
    if (result.status !== "fulfilled") {
      lastError = result.reason;
      continue;
    }
    anyOk = true;
    for (const item of itemsFromRss(result.value)) {
      if (!item.link || !item.title) continue;
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      const blob = `${item.title} ${item.description}`;
      jobs.push({
        source: "FREELANCER",
        externalId: item.link,
        title: item.title.slice(0, 200),
        company: "Freelancer.com client",
        place: "Remote",
        remote: true,
        engagement: engagementFrom(blob),
        budget: budgetFrom(blob),
        duration: "",
        url: item.link.slice(0, 2000),
        description: item.description.slice(0, 20_000),
        postedAt: postedIso(item.pubDate),
      });
    }
  }
  if (!anyOk) {
    if (lastError instanceof SourceError) throw lastError;
    throw new SourceError("did not answer");
  }
  return jobs;
}
