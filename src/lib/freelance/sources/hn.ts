import "server-only";

import { z } from "zod";

import { isJobSeekerHnPost } from "@/lib/startups/sources/hn";
import { htmlToText, firstLine, firstLink, headerParts } from "@/lib/startups/text";
import { reach, type Place } from "@/lib/startups/place";

import { getJson, SourceError } from "./http";
import type { FoundFreelance } from "../types";

// Hacker News: monthly "Ask HN: Freelancer? Seeking freelancer?" thread
// (client posts only).

const SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=15";
const itemUrl = (id: string) => `https://hn.algolia.com/api/v1/items/${id}`;

const searchSchema = z.object({
  hits: z.array(z.object({ objectID: z.string(), title: z.string().nullish(), created_at: z.string().nullish() })),
});
const postSchema = z.object({
  id: z.union([z.number(), z.string()]),
  text: z.string().nullish(),
  created_at: z.string().nullish(),
});
const threadSchema = z.object({ children: z.array(z.unknown()) });

const SEEKING_FREELANCER =
  /\b(?:seeking|looking\s+for|need(?:ing)?|hiring)\s+(?:a\s+)?(?:freelance|contractor|consultant|part[-\s]?time)\b|\b(?:freelancer|contractor|consultant)\s+(?:wanted|needed)\b|\b(?:project|contract)\s+(?:for|with)\b|\b(?:budget|rate|\$\d)/i;

const SEEKING_WORK =
  /\b(?:available\s+for\s+(?:hire|work|freelance)|seeking\s+(?:freelance|contract)\s+work|looking\s+for\s+(?:freelance|contract)\s+(?:work|gigs?|projects?)|hire\s+me)\b/i;

function engagementFrom(text: string): FoundFreelance["engagement"] {
  if (/\b(project|one[-\s]?off|build\s+(?:a|an|the))\b/i.test(text)) return "PROJECT";
  if (/\b(temporary|temp|short[-\s]?term|few\s+weeks|months?\s+contract)\b/i.test(text)) return "TEMPORARY";
  return "CONTRACT";
}

function budgetFrom(text: string): string {
  const match = text.match(/\$[\d,]+(?:\s*[-–]\s*\$?[\d,]+)?(?:\s*\/\s*(?:hr|hour|mo|month|week|day))?/i);
  return match?.[0]?.slice(0, 80) ?? "";
}

export function freelanceFromHnPost(post: z.output<typeof postSchema>, place: Place): FoundFreelance | null {
  if (!post.text) return null;
  const text = htmlToText(post.text);
  if (text.length < 60) return null;
  if (isJobSeekerHnPost(text) || SEEKING_WORK.test(text)) return null;
  if (!SEEKING_FREELANCER.test(text) && !/\b(freelance|contractor|consultant|contract)\b/i.test(text)) return null;

  const parts = headerParts(text);
  const company = (parts[0] ?? firstLine(text) ?? "HN client")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\W+|\W+$/g, "")
    .trim()
    .slice(0, 120);
  if (company.length < 2) return null;

  const header = parts.join(" | ");
  const where = reach(header, place);
  const anywhere = !place.country && place.cityNames.length === 0;
  if (!anywhere && where.here === null && !(where.remote && where.remoteOpen !== false)) return null;

  const link = `https://news.ycombinator.com/item?id=${post.id}`;
  const site = firstLink(text);
  return {
    source: "HN",
    externalId: String(post.id),
    title: firstLine(text).slice(0, 160) || header.slice(0, 160),
    company,
    place: parts
      .slice(1)
      .filter((part) => /\b(remote|on-?site|hybrid)\b/i.test(part) || reach(part, place).here !== null)
      .join(" · ")
      .slice(0, 300),
    remote: where.remote ? true : where.here ? false : null,
    engagement: engagementFrom(text),
    budget: budgetFrom(text),
    duration: "",
    url: site || link,
    description: text.slice(0, 20_000),
    postedAt: post.created_at ?? null,
  };
}

/** This month's "Freelancer? Seeking freelancer?" posts that suit `place`. */
export async function fetchHnFreelance(place: Place, signal?: AbortSignal): Promise<FoundFreelance[]> {
  let rawSearch: unknown;
  try {
    rawSearch = await getJson(SEARCH_URL, { signal });
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("couldn't be reached");
  }
  const search = searchSchema.safeParse(rawSearch);
  if (!search.success) throw new SourceError("changed its format");
  const thread = search.data.hits.find((hit) => /freelancer\?\s*seeking\s+freelancer/i.test(hit.title ?? ""));
  if (!thread) throw new SourceError("has no freelancer thread this month");
  let rawThread: unknown;
  try {
    rawThread = await getJson(itemUrl(thread.objectID), { signal });
  } catch (error) {
    if (error instanceof SourceError) throw error;
    throw new SourceError("couldn't be reached");
  }
  const answer = threadSchema.safeParse(rawThread);
  if (!answer.success) throw new SourceError("changed its format");
  return answer.data.children.flatMap((child) => {
    const post = postSchema.safeParse(child);
    return post.success ? (freelanceFromHnPost(post.data, place) ?? []) : [];
  });
}
