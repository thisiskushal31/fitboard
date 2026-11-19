import "server-only";

import { z } from "zod";

import { getJson, SourceError } from "./http";
import type { FoundFreelance } from "../types";

// Remotive: public remote-jobs JSON; contract / freelance / temporary rows only.

const ENDPOINT = "https://remotive.com/api/remote-jobs";

const CONTRACTISH = /\b(contract|freelance|freelancer|consultant|temporary|temp\b|part[-\s]?time|fixed[-\s]?term)\b/i;

const jobSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  url: z.string().optional(),
  title: z.string().optional(),
  company_name: z.string().optional(),
  candidate_required_location: z.string().optional(),
  job_type: z.string().optional(),
  description: z.string().optional(),
  publication_date: z.string().optional(),
  salary: z.string().optional(),
});

const payloadSchema = z.object({ jobs: z.array(z.unknown()) });

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function engagementFrom(jobType: string, blob: string): FoundFreelance["engagement"] {
  if (/\b(temporary|temp|fixed[-\s]?term)\b/i.test(`${jobType} ${blob}`)) return "TEMPORARY";
  if (/\b(project|one[-\s]?off)\b/i.test(blob)) return "PROJECT";
  return "CONTRACT";
}

/** Remotive remote jobs that look like contract / freelance / temporary work. */
export async function fetchRemotiveFreelance(signal?: AbortSignal): Promise<FoundFreelance[]> {
  const parsed = payloadSchema.safeParse(await getJson(ENDPOINT, { signal }));
  if (!parsed.success) throw new SourceError("changed its format");
  const jobs: FoundFreelance[] = [];
  for (const raw of parsed.data.jobs) {
    const item = jobSchema.safeParse(raw);
    if (!item.success) continue;
    const title = item.data.title?.trim() ?? "";
    const jobType = item.data.job_type ?? "";
    const description = stripHtml(item.data.description ?? "");
    const blob = `${title} ${jobType} ${description}`;
    if (!CONTRACTISH.test(blob) && !/contract/i.test(jobType)) continue;
    const url = item.data.url?.trim() ?? "";
    if (!title || !url) continue;
    jobs.push({
      source: "REMOTIVE",
      externalId: String(item.data.id ?? url),
      title: title.slice(0, 200),
      company: (item.data.company_name ?? "").slice(0, 200),
      place: (item.data.candidate_required_location ?? "").slice(0, 300),
      remote: true,
      engagement: engagementFrom(jobType, blob),
      budget: (item.data.salary ?? "").slice(0, 120),
      duration: "",
      url: url.slice(0, 2000),
      description: description.slice(0, 20_000),
      postedAt: item.data.publication_date ?? null,
    });
  }
  return jobs;
}
