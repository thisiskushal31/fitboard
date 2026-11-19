import "server-only";

import { getText, settledInBatches, SourceError } from "./http";
import { itemsFromRss, postedIso } from "./rss";
import type { FoundFreelance } from "../types";

// We Work Remotely: public RSS feeds that lean contract / freelance.

/** Feeds fetched at once. */
const CONCURRENCY = 3;

const FEEDS = [
  "https://weworkremotely.com/categories/remote-contracting-jobs.rss",
  "https://weworkremotely.com/categories/remote-full-stack-programming-jobs.rss",
  "https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss",
] as const;

const CONTRACTISH = /\b(contract|freelance|freelancer|consultant|temporary|part[-\s]?time)\b/i;

function engagementFrom(blob: string): FoundFreelance["engagement"] {
  if (/\b(temporary|temp|short[-\s]?term)\b/i.test(blob)) return "TEMPORARY";
  if (/\b(project|one[-\s]?off)\b/i.test(blob)) return "PROJECT";
  return "CONTRACT";
}

function companyFromTitle(title: string): { company: string; title: string } {
  if (!title.includes(":")) return { company: "", title };
  const company = title.split(":", 1)[0].trim();
  const rest = title.slice(title.indexOf(":") + 1).trim() || title;
  return { company, title: rest };
}

/** We Work Remotely contract-leaning feeds; programming feeds keep contract-marked rows only. */
export async function fetchWwrFreelance(signal?: AbortSignal): Promise<FoundFreelance[]> {
  const results = await settledInBatches(FEEDS, CONCURRENCY, (url) => getText(url, { signal }));
  const jobs: FoundFreelance[] = [];
  const seen = new Set<string>();
  let anyOk = false;
  let lastError: unknown;
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    if (result.status !== "fulfilled") {
      lastError = result.reason;
      continue;
    }
    anyOk = true;
    const fromContractFeed = FEEDS[index].includes("contracting");
    for (const item of itemsFromRss(result.value)) {
      if (!item.link || !item.title) continue;
      const { company, title } = companyFromTitle(item.title);
      const blob = `${title} ${item.description}`;
      if (!fromContractFeed && !CONTRACTISH.test(blob)) continue;
      if (seen.has(item.link)) continue;
      seen.add(item.link);
      jobs.push({
        source: "WWR",
        externalId: item.link,
        title: title.slice(0, 200),
        company: company.slice(0, 200),
        place: "Remote",
        remote: true,
        engagement: engagementFrom(blob),
        budget: "",
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
