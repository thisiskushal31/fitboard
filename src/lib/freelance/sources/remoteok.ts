import "server-only";

import { z } from "zod";

import { getJson, SourceError } from "./http";
import type { FoundFreelance } from "../types";

// Remote OK: public JSON feed; contract / freelance / temporary rows only.

const ENDPOINT = "https://remoteok.com/api";

const CONTRACTISH = /\b(contract|freelance|freelancer|consultant|temporary|temp\b|part[-\s]?time|fixed[-\s]?term)\b/i;

const jobSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  url: z.string().optional(),
  position: z.string().optional(),
  company: z.string().optional(),
  location: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  date: z.string().optional(),
  salary_min: z.number().optional(),
  salary_max: z.number().optional(),
}).passthrough();

function stripHtml(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function engagementFrom(blob: string): FoundFreelance["engagement"] {
  if (/\b(temporary|temp|fixed[-\s]?term)\b/i.test(blob)) return "TEMPORARY";
  if (/\b(project|one[-\s]?off)\b/i.test(blob)) return "PROJECT";
  return "CONTRACT";
}

function budgetFrom(min?: number, max?: number): string {
  const low = min && min > 0 ? min : undefined;
  const high = max && max > 0 ? max : undefined;
  if (!low && !high) return "";
  if (low && high && low !== high) return `$${low.toLocaleString()}–$${high.toLocaleString()}`;
  return `$${(high ?? low)!.toLocaleString()}`;
}

/** Remote OK's public JSON feed, keeping contract / freelance / temporary rows only. */
export async function fetchRemoteOkFreelance(signal?: AbortSignal): Promise<FoundFreelance[]> {
  const payload = await getJson(ENDPOINT, { signal });
  if (!Array.isArray(payload)) throw new SourceError("changed its format");
  const jobs: FoundFreelance[] = [];
  for (const entry of payload) {
    // API preamble row (legal text) has neither id nor position.
    if (!entry || typeof entry !== "object" || (!("id" in entry) && !("position" in entry))) continue;
    const parsed = jobSchema.safeParse(entry);
    if (!parsed.success) continue;
    const item = parsed.data;
    const title = item.position?.trim() ?? "";
    const tags = (item.tags ?? []).join(" ");
    const description = stripHtml(item.description ?? "");
    const blob = `${title} ${tags} ${description}`;
    if (!CONTRACTISH.test(blob)) continue;
    const url = item.url?.trim() ?? "";
    if (!title || !url) continue;
    jobs.push({
      source: "REMOTEOK",
      externalId: String(item.id ?? url),
      title: title.slice(0, 200),
      company: (item.company ?? "").slice(0, 200),
      place: (item.location ?? "Remote").slice(0, 300),
      remote: true,
      engagement: engagementFrom(blob),
      budget: budgetFrom(item.salary_min, item.salary_max),
      duration: "",
      url: url.slice(0, 2000),
      description: description.slice(0, 20_000),
      postedAt: item.date ?? null,
    });
  }
  return jobs;
}
