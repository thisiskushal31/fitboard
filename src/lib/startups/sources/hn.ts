import "server-only";

import { z } from "zod";

import { getJson, SourceError } from "../http";
import { reach, type Place } from "../place";
import { companySite, emailLabel, findEmails, firstLine, firstLink, headerParts, htmlToText } from "../text";
import type { FoundStartup } from "../types";
import { hnItemLink } from "./yc";

// Hacker News "Ask HN: Who is hiring?", the monthly thread where
// companies, mostly startups, post their open roles, often with an address
// to apply to. Read through HN's public Algolia API (hn.algolia.com/api).
// Only posts someone in the profile's city or country could take are kept:
// ones there, or remote and not only for other places.

const SEARCH_URL = "https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10";
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

const ROLE = /\b(engineer|developer|programmer|architect|designer|scientist|manager|lead|head of|founding|sre|devops|intern|analyst|researcher|marketer|writer|recruiter|specialist|consultant)\b/i;
const WORK_MODE = /\b(remote|on-?site|hybrid|in[-\s]office|relocation)\b/i;

/** Someone posting their own CV into "Who is hiring?" (wrong thread: "Who wants to be hired?"). */
const SEEKING_WORK =
  /\b(i(?:['’]m| am)\s+(?:currently\s+)?(?:looking|seeking|searching)\s+for)\b|\b(?:looking|seeking|searching)\s+for\s+(?:a\s+)?(?:new\s+)?(?:role|job|opportunity|opportunities|position|gigs?)\b|\bopen\s+to\s+(?:remote\s+)?(?:opportunities|roles|positions|offers)\b|\b(?:hire\s+me|available\s+for\s+(?:hire|work|opportunities))\b|\bwho\s+wants\s+to\s+be\s+hired\b|\b(?:feel\s+free\s+to\s+reach\s+out).{0,80}\b(?:resume|cv|linkedin)\b/i;
/** A company actually hiring — keeps real posts that also say "looking for an engineer". */
const COMPANY_HIRING =
  /\b(?:we(?:['’]re| are)|(?:company|startup|team)\s+is)\s+hiring\b|\bis\s+hiring\b|\bare\s+hiring\b|\bhiring\s+(?:for|a|an)\b|\bjoin\s+(?:our|us|the\s+team)\b|\bwe(?:['’]re| are)\s+looking\s+for\s+(?:an?\s+)?(?:engineer|developer|designer|founding)/i;

/**
 * True when the comment is a person seeking work, not a company hiring.
 * Catches "Who wants to be hired?" posts dropped into the hiring thread.
 */
export function isJobSeekerHnPost(text: string): boolean {
  if (COMPANY_HIRING.test(text)) return false;
  if (SEEKING_WORK.test(text)) return true;
  // Header like "Jane Doe | Backend Engineer | Remote" plus a personal resume pitch.
  const parts = headerParts(text);
  const lead = parts[0] ?? "";
  const personName = /^[\p{L}][\p{L}'’.-]*(?:\s+[\p{L}][\p{L}'’.-]*){1,3}$/u.test(lead) && !/\b(inc|llc|ltd|gmbh|corp|labs?|studio|systems?|software|technologies|ai|io)\b/i.test(lead);
  const personalPitch = /\b(my\s+(?:resume|cv|portfolio|github|linkedin)|years?\s+of\s+experience|technical\s+skills\s*:)/i.test(text);
  return personName && personalPitch;
}

/** A "Who is hiring?" post as a startup, or null when it isn't one someone in `place` could take. */
export function startupFromHnPost(post: z.output<typeof postSchema>, place: Place): FoundStartup | null {
  if (!post.text) return null;
  const text = htmlToText(post.text);
  if (isJobSeekerHnPost(text)) return null;
  const parts = headerParts(text);
  const company = (parts[0] ?? "")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\s*\(.*\)\s*$/, "")
    .replace(/^\W+|\W+$/g, "")
    .trim()
    .slice(0, 120);
  if (company.length < 2) return null;
  const header = parts.join(" | ");
  const where = reach(header, place);
  const anywhere = !place.country && place.cityNames.length === 0;
  if (!anywhere && where.here === null && !(where.remote && where.remoteOpen !== false)) return null;

  const link = hnItemLink(post.id);
  const site = firstLink(text);
  const website = site ? companySite(site) : "";
  return {
    source: "HN",
    externalId: String(post.id),
    company,
    website,
    summary: firstLine(text.split("\n").slice(1).join("\n")) || header,
    details: text.slice(0, 20_000),
    location: parts
      .slice(1)
      .filter((part) => WORK_MODE.test(part) || reach(part, place).here !== null || /^[A-Z][\p{L} .'-]+,\s*[A-Z]{2}\b/u.test(part))
      .join(" · ")
      .slice(0, 300),
    remote: where.remote ? true : where.here ? false : null,
    // A round named in the header, else the YC batch in the company's brackets: "Tiller (YC W24)".
    stage: parts.slice(1).find((part) => /^(pre-seed|seed|series [a-e]|bootstrapped|profitable)\b/i.test(part)) ?? /\((yc [wsfpx]\d{2})\)/i.exec(parts[0] ?? "")?.[1]?.toUpperCase() ?? "",
    roles: parts.filter((part) => ROLE.test(part) && part.length < 160).slice(0, 6),
    // Addresses the post gives for applying, as written; hidden ones ("jane at acme dot com") stay in the text for the reader.
    emails: findEmails(text).map((email) => ({ email, label: emailLabel(email), from: link, onRequest: false, foundAt: post.created_at ?? "" })),
    links: [{ label: "Hiring post", url: link }, ...(website ? [{ label: "Website", url: website }] : [])],
    postedAt: post.created_at ?? null,
  };
}

/** This month's "Who is hiring?" posts that suit someone in `place`. */
export async function fetchHnStartups(place: Place, signal?: AbortSignal): Promise<FoundStartup[]> {
  const search = searchSchema.safeParse(await getJson(SEARCH_URL, { signal }));
  if (!search.success) throw new SourceError("changed its format");
  const thread = search.data.hits.find((hit) => /^ask hn: who is hiring\?/i.test(hit.title ?? ""));
  if (!thread) throw new SourceError("has no hiring thread this month");
  const answer = threadSchema.safeParse(await getJson(itemUrl(thread.objectID), { signal }));
  if (!answer.success) throw new SourceError("changed its format");
  return answer.data.children.flatMap((child) => {
    const post = postSchema.safeParse(child);
    return post.success ? (startupFromHnPost(post.data, place) ?? []) : [];
  });
}
