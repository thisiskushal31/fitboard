import "server-only";

import catalog from "../../../config/job-boards.json";
import { COUNTRY_REGION, detectRegions, matchesArea, matchesCountry, mentionsPlace, openInCountry, zoneByCode, zoneRegion, type Region } from "./regions";

// Companies and shared boards live in config/job-boards.json. A company row is
// the public URL you would open: Greenhouse, Lever, Ashby, Recruitee, or
// SmartRecruiters is crawled; any other URL is only a link on Career path.
// Add or remove a company there. One dead board does not fail the crawl.
// Adzuna, JSearch, FreeHire, and the Bundesagentur stay as their own sources.

const USER_AGENT = "Fitboard/1.0 (public ATS job search)";
const TIMEOUT_MS = 20_000;
const TTL_MS = 30 * 60 * 1000;

export type CrawledPosting = {
  externalId: string;
  title: string;
  company: string;
  place: string;
  remote: boolean | null;
  salary: string;
  postedAt: string | null;
  url: string;
  via: string;
  description: string;
};

export type CareerLink = { name: string; url: string };

type BoardKind = "greenhouse" | "lever" | "ashby" | "recruitee" | "smartrecruiters";

/** The public URL from config, or null when that page is not one of the crawled boards. */
function readBoard(url: string): { kind: BoardKind; slug: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  const slug = decodeURIComponent(parsed.pathname.split("/").filter(Boolean)[0] ?? "");
  if ((host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") && slug) return { kind: "greenhouse", slug };
  if (host === "jobs.lever.co" && slug) return { kind: "lever", slug };
  if (host === "jobs.ashbyhq.com" && slug) return { kind: "ashby", slug };
  if (host.endsWith(".recruitee.com") && host !== "recruitee.com") return { kind: "recruitee", slug: host.slice(0, -".recruitee.com".length) };
  if (host === "jobs.smartrecruiters.com" && slug) return { kind: "smartrecruiters", slug };
  return null;
}

export function officialCareers(): CareerLink[] {
  return catalog.companies.filter((row) => row.name && row.url && !readBoard(row.url));
}

const ROLE_HINTS = [
  "devops",
  "sre",
  "site reliability",
  "platform engineer",
  "platform engineering",
  "infrastructure",
  "cloud engineer",
  "cloud architect",
  "kubernetes",
  "gitops",
  "production engineer",
  "reliability",
  "software engineer",
  "software development",
  "backend",
  "mlops",
  "ai engineer",
  "machine learning",
  "security engineer",
  "detection engineer",
  "threat intelligence",
  "forward deployed",
  "forward-deployed",
];

const SKILL_HINTS = ["kubernetes", "k8s", "terraform", "gitops", "argocd", "helm", "devops", "sre", "aws", "gcp", "azure", "gke", "eks", "observability", "prometheus", "infrastructure"];

export function isRelevantListing(title: string, description = ""): boolean {
  const titleL = title.toLowerCase();
  const blob = `${titleL} ${description.slice(0, 2500).toLowerCase()}`;
  const skillHits = SKILL_HINTS.filter((hint) => blob.includes(hint)).length;
  if (skillHits >= 2) return true;
  const titleHit = ROLE_HINTS.some((hint) => titleL.includes(hint));
  if (titleHit && skillHits >= 1) return true;
  return titleHit;
}

function stripHtml(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function postedAtOf(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const text = String(value).trim();
  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  return null;
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, {
    signal,
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.json();
}

async function getText(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, {
    signal,
    headers: { accept: "application/rss+xml, application/xml, text/xml, */*", "user-agent": USER_AGENT },
    redirect: "follow",
  });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

function withTimeout(parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  if (!parent) return timeout;
  return AbortSignal.any([parent, timeout]);
}

function posting(partial: CrawledPosting): CrawledPosting {
  return {
    ...partial,
    externalId: partial.externalId.slice(0, 500),
    title: partial.title.slice(0, 500),
    company: partial.company.slice(0, 300),
    place: partial.place.slice(0, 300),
    salary: partial.salary.slice(0, 200),
    url: partial.url.slice(0, 2000),
    via: partial.via.slice(0, 100),
    description: partial.description.slice(0, 100_000),
  };
}

async function fetchGreenhouse(company: string, board: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const payload = (await getJson(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(board)}/jobs?content=true`, signal)) as {
    jobs?: { id?: string | number; title?: string; content?: string; absolute_url?: string; location?: { name?: string }; updated_at?: string; created_at?: string }[];
  };
  const jobs: CrawledPosting[] = [];
  for (const item of payload.jobs ?? []) {
    const title = item.title ?? "";
    const description = stripHtml(item.content);
    if (!isRelevantListing(title, description)) continue;
    const place = item.location?.name ?? "";
    const blob = `${place} ${title} ${description}`.toLowerCase();
    jobs.push(
      posting({
        externalId: `greenhouse-${board}-${item.id ?? title}`,
        title,
        company,
        place,
        remote: blob.includes("remote"),
        salary: "",
        postedAt: postedAtOf(item.updated_at || item.created_at),
        url: item.absolute_url ?? "",
        via: `Greenhouse · ${company}`,
        description,
      }),
    );
  }
  return jobs;
}

async function fetchLever(company: string, board: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const payload = await getJson(`https://api.lever.co/v0/postings/${encodeURIComponent(board)}?mode=json`, signal);
  if (!Array.isArray(payload)) return [];
  const jobs: CrawledPosting[] = [];
  for (const item of payload as { id?: string; text?: string; descriptionPlain?: string; description?: string; categories?: { location?: string }; hostedUrl?: string; applyUrl?: string; createdAt?: number }[]) {
    const title = item.text ?? "";
    const description = stripHtml(item.descriptionPlain || item.description);
    if (!isRelevantListing(title, description)) continue;
    const place = item.categories?.location ?? "";
    jobs.push(
      posting({
        externalId: `lever-${board}-${item.id ?? title}`,
        title,
        company,
        place,
        remote: `${place} ${title}`.toLowerCase().includes("remote"),
        salary: "",
        postedAt: postedAtOf(item.createdAt),
        url: item.hostedUrl || item.applyUrl || "",
        via: `Lever · ${company}`,
        description,
      }),
    );
  }
  return jobs;
}

async function fetchAshby(company: string, board: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const payload = (await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board)}`, signal)) as {
    jobs?: { id?: string; jobId?: string; title?: string; descriptionHtml?: string; descriptionPlain?: string; location?: string | { locationName?: string; name?: string }; jobUrl?: string; applyUrl?: string; publishedDate?: string; publishedAt?: string; isRemote?: boolean }[];
  };
  const jobs: CrawledPosting[] = [];
  for (const item of payload.jobs ?? []) {
    const title = item.title ?? "";
    const description = stripHtml(item.descriptionHtml || item.descriptionPlain);
    if (!isRelevantListing(title, description)) continue;
    const loc = item.location;
    const place = typeof loc === "string" ? loc : loc?.locationName || loc?.name || "";
    jobs.push(
      posting({
        externalId: `ashby-${board}-${item.id || item.jobId || title}`,
        title,
        company,
        place,
        remote: Boolean(item.isRemote) || place.toLowerCase().includes("remote"),
        salary: "",
        postedAt: postedAtOf(item.publishedDate || item.publishedAt),
        url: item.jobUrl || item.applyUrl || "",
        via: `Ashby · ${company}`,
        description,
      }),
    );
  }
  return jobs;
}

async function fetchRecruitee(company: string, board: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const payload = (await getJson(`https://${encodeURIComponent(board)}.recruitee.com/api/offers/`, signal)) as {
    offers?: { id?: string | number; title?: string; description?: string; requirements?: string; location?: string; city?: string; careers_url?: string; careers_apply_url?: string; published_at?: string; created_at?: string; remote?: boolean }[];
  };
  const jobs: CrawledPosting[] = [];
  for (const item of payload.offers ?? []) {
    const title = item.title ?? "";
    const description = stripHtml(item.description || item.requirements);
    if (!isRelevantListing(title, description)) continue;
    const place = String(item.location || item.city || "");
    jobs.push(
      posting({
        externalId: `recruitee-${board}-${item.id ?? title}`,
        title,
        company,
        place,
        remote: Boolean(item.remote) || place.toLowerCase().includes("remote"),
        salary: "",
        postedAt: postedAtOf(item.published_at || item.created_at),
        url: item.careers_url || item.careers_apply_url || "",
        via: `Recruitee · ${company}`,
        description,
      }),
    );
  }
  return jobs;
}

async function fetchSmartRecruiters(company: string, board: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const jobs: CrawledPosting[] = [];
  let offset = 0;
  let total = Infinity;
  while (offset < total && offset < 300) {
    const payload = (await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board)}/postings?limit=100&offset=${offset}`, signal)) as {
      totalFound?: number;
      content?: { id?: string; uuid?: string; name?: string; location?: { fullLocation?: string; city?: string; remote?: boolean }; releasedDate?: string }[];
    };
    const batch = payload.content ?? [];
    total = payload.totalFound ?? offset + batch.length;
    for (const item of batch) {
      const title = item.name ?? "";
      if (!isRelevantListing(title)) continue;
      const place = item.location?.fullLocation || item.location?.city || "";
      const id = item.id || item.uuid || title;
      jobs.push(
        posting({
          externalId: `smartrecruiters-${board}-${id}`,
          title,
          company,
          place,
          remote: Boolean(item.location?.remote) || place.toLowerCase().includes("remote"),
          salary: "",
          postedAt: postedAtOf(item.releasedDate),
          url: `https://jobs.smartrecruiters.com/${board}/${id}`,
          via: `SmartRecruiters · ${company}`,
          description: "",
        }),
      );
    }
    if (batch.length === 0) break;
    offset += batch.length;
  }
  return jobs;
}

function rssItems(xml: string): { title: string; link: string; description: string; pubDate: string }[] {
  return xml
    .split(/<item[\s>]/i)
    .slice(1)
    .map((block) => {
      const tag = (name: string) => {
        const cdata = block.match(new RegExp(`<${name}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>`, "i"));
        const plain = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
        return (cdata?.[1] ?? plain?.[1] ?? "").trim();
      };
      return { title: stripHtml(tag("title")), link: tag("link").trim(), description: stripHtml(tag("description") || tag("encoded")), pubDate: tag("pubDate") };
    });
}

async function fetchRss(url: string, source: string, place: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const xml = await getText(url, signal);
  const jobs: CrawledPosting[] = [];
  for (const item of rssItems(xml)) {
    if (!isRelevantListing(item.title, item.description)) continue;
    const company = item.title.includes(":") ? item.title.split(":")[0].trim() : source;
    jobs.push(
      posting({
        externalId: `${source}-${item.link || item.title}`,
        title: item.title,
        company,
        place,
        remote: place === "" ? true : `${item.title} ${item.description}`.toLowerCase().includes("remote"),
        salary: "",
        postedAt: postedAtOf(item.pubDate),
        url: item.link,
        via: source,
        description: item.description,
      }),
    );
  }
  return jobs;
}

async function fetchRemotive(endpoint: string, query: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const url = new URL(endpoint);
  url.searchParams.set("search", query);
  url.searchParams.set("limit", "50");
  const payload = (await getJson(url.toString(), signal)) as {
    jobs?: { id?: string | number; title?: string; company_name?: string; url?: string; candidate_required_location?: string; description?: string; publication_date?: string; salary?: string }[];
  };
  return (payload.jobs ?? []).map((item) =>
    posting({
      externalId: `remotive-${item.id ?? item.title}`,
      title: item.title ?? "",
      company: item.company_name ?? "",
      place: item.candidate_required_location || "Remote",
      remote: true,
      salary: item.salary ?? "",
      postedAt: postedAtOf(item.publication_date),
      url: item.url ?? "",
      via: "Remotive",
      description: stripHtml(item.description),
    }),
  );
}

async function fetchRemoteOk(endpoint: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const payload = await getJson(endpoint, signal);
  if (!Array.isArray(payload)) return [];
  const jobs: CrawledPosting[] = [];
  for (const item of payload as { id?: string; slug?: string; position?: string; company?: string; url?: string; apply_url?: string; location?: string; description?: string; date?: string; epoch?: number }[]) {
    if (!item.position) continue;
    jobs.push(
      posting({
        externalId: `remoteok-${item.id || item.slug || item.position}`,
        title: item.position,
        company: item.company ?? "",
        place: item.location || "Remote",
        remote: true,
        salary: "",
        postedAt: postedAtOf(item.epoch || item.date),
        url: item.url || item.apply_url || "",
        via: "RemoteOK",
        description: stripHtml(item.description),
      }),
    );
  }
  return jobs;
}

async function fetchArbeitnow(endpoint: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const payload = (await getJson(endpoint, signal)) as {
    data?: { slug?: string; title?: string; company_name?: string; url?: string; location?: string; description?: string; created_at?: string; remote?: boolean }[];
  };
  return (payload.data ?? []).map((item) =>
    posting({
      externalId: `arbeitnow-${item.slug ?? item.title}`,
      title: item.title ?? "",
      company: item.company_name ?? "",
      place: item.location ?? "",
      remote: Boolean(item.remote),
      salary: "",
      postedAt: postedAtOf(item.created_at),
      url: item.url ?? "",
      via: "Arbeitnow",
      description: stripHtml(item.description),
    }),
  );
}

async function fetchHn(endpoint: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const root = endpoint.replace(/\/$/, "");
  const searchUrl = new URL(`${root}/search`);
  searchUrl.searchParams.set("query", "Ask HN: Who is hiring?");
  searchUrl.searchParams.set("tags", "story");
  searchUrl.searchParams.set("hitsPerPage", "1");
  const search = (await getJson(searchUrl.toString(), signal)) as {
    hits?: { objectID?: string }[];
  };
  const storyId = search.hits?.[0]?.objectID;
  if (!storyId) return [];
  const commentsUrl = new URL(`${root}/search_by_date`);
  commentsUrl.searchParams.set("tags", `comment,story_${storyId}`);
  commentsUrl.searchParams.set("hitsPerPage", "80");
  const comments = (await getJson(commentsUrl.toString(), signal)) as {
    hits?: { objectID?: string; comment_text?: string; created_at?: string }[];
  };
  const jobs: CrawledPosting[] = [];
  for (const item of comments.hits ?? []) {
    const description = stripHtml(item.comment_text);
    if (description.length < 80) continue;
    jobs.push(
      posting({
        externalId: `hn-${item.objectID}`,
        title: description.split("\n", 1)[0].slice(0, 140),
        company: "Hacker News thread",
        place: "See post",
        remote: description.toLowerCase().includes("remote"),
        salary: "",
        postedAt: postedAtOf(item.created_at),
        url: `https://news.ycombinator.com/item?id=${item.objectID}`,
        via: "HN Who is Hiring",
        description,
      }),
    );
  }
  return jobs;
}

async function fetchCodeforces(endpoint: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const url = new URL(endpoint);
  url.searchParams.set("maxCount", "100");
  const payload = (await getJson(url.toString(), signal)) as {
    status?: string;
    comment?: string;
    result?: { blogEntry?: { id?: number; title?: string; content?: string }; timeSeconds?: number }[];
  };
  if (payload.status !== "OK") throw new Error(payload.comment || "Codeforces API error");
  const jobs: CrawledPosting[] = [];
  for (const item of payload.result ?? []) {
    const title = item.blogEntry?.title ?? "";
    const description = stripHtml(item.blogEntry?.content);
    const blob = `${title} ${description}`.toLowerCase();
    if (!blob.includes("hiring") && !blob.includes("job") && !blob.includes("vacancy")) continue;
    jobs.push(
      posting({
        externalId: `codeforces-${item.blogEntry?.id ?? title}`,
        title: title || "Codeforces hiring post",
        company: "Codeforces",
        place: "",
        remote: blob.includes("remote"),
        salary: "",
        postedAt: postedAtOf(item.timeSeconds),
        url: item.blogEntry?.id ? `https://codeforces.com/blog/entry/${item.blogEntry.id}` : "https://codeforces.com",
        via: "Codeforces",
        description,
      }),
    );
  }
  return jobs;
}

async function fetchMyCareersFuture(endpoint: string, query: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  const url = new URL(endpoint);
  url.searchParams.set("search", query);
  url.searchParams.set("limit", "20");
  const payload = (await getJson(url.toString(), signal)) as {
    results?: {
      title?: string;
      description?: string;
      uuid?: string;
      postedCompany?: { name?: string };
      hiringCompany?: { name?: string };
      metadata?: { jobDetailsUrl?: string; jobPostId?: string; newPostingDate?: string };
      address?: { overseasCountry?: string; districts?: { location?: string }[] };
      salary?: { minimum?: number; maximum?: number };
    }[];
  };
  const jobs: CrawledPosting[] = [];
  for (const item of payload.results ?? []) {
    const title = item.title ?? "";
    const description = stripHtml(item.description);
    if (!isRelevantListing(title, description)) continue;
    const company = item.postedCompany?.name || item.hiringCompany?.name || "Singapore employer";
    const place = [item.address?.overseasCountry, item.address?.districts?.[0]?.location, "Singapore"].filter(Boolean).join(", ");
    const salary = item.salary?.minimum || item.salary?.maximum ? `${item.salary?.minimum ?? ""}-${item.salary?.maximum ?? ""} SGD` : "";
    jobs.push(
      posting({
        externalId: `mcf-${item.uuid || item.metadata?.jobPostId || title}`,
        title,
        company,
        place,
        remote: `${title} ${description} ${place}`.toLowerCase().includes("remote"),
        salary,
        postedAt: postedAtOf(item.metadata?.newPostingDate),
        url: item.metadata?.jobDetailsUrl ?? "",
        via: "MyCareersFuture (SG)",
        description,
      }),
    );
  }
  return jobs;
}

async function pool<T>(work: (() => Promise<T>)[], limit: number): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(work.length);
  let next = 0;
  async function worker() {
    while (next < work.length) {
      const index = next++;
      try {
        results[index] = { status: "fulfilled", value: await work[index]() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, work.length) }, () => worker()));
  return results;
}

let cache: { at: number; postings: CrawledPosting[] } | null = null;

/** Every public board, cached for 30 minutes. One dead board does not fail the crawl. */
export async function crawlPublicBoards(query: string, signal?: AbortSignal): Promise<CrawledPosting[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.postings;
  const keywords = query.trim() || "software engineer";
  const { remotive, remoteOk, arbeitnow, hackerNews, codeforces, myCareersFuture } = catalog.jobBoards;
  const tasks: (() => Promise<CrawledPosting[]>)[] = [];
  if (remotive) tasks.push(() => fetchRemotive(remotive, keywords, withTimeout(signal)));
  if (remoteOk) tasks.push(() => fetchRemoteOk(remoteOk, withTimeout(signal)));
  if (arbeitnow) tasks.push(() => fetchArbeitnow(arbeitnow, withTimeout(signal)));
  if (hackerNews) tasks.push(() => fetchHn(hackerNews, withTimeout(signal)));
  if (codeforces) tasks.push(() => fetchCodeforces(codeforces, withTimeout(signal)));
  if (myCareersFuture) tasks.push(() => fetchMyCareersFuture(myCareersFuture, keywords, withTimeout(signal)));
  for (const feed of catalog.feeds) tasks.push(() => fetchRss(feed.url, feed.name, feed.place, withTimeout(signal)));
  for (const company of catalog.companies) {
    const board = readBoard(company.url);
    if (!board) continue;
    if (board.kind === "greenhouse") tasks.push(() => fetchGreenhouse(company.name, board.slug, withTimeout(signal)));
    else if (board.kind === "lever") tasks.push(() => fetchLever(company.name, board.slug, withTimeout(signal)));
    else if (board.kind === "ashby") tasks.push(() => fetchAshby(company.name, board.slug, withTimeout(signal)));
    else if (board.kind === "recruitee") tasks.push(() => fetchRecruitee(company.name, board.slug, withTimeout(signal)));
    else tasks.push(() => fetchSmartRecruiters(company.name, board.slug, withTimeout(signal)));
  }
  const settled = await pool(tasks, 16);
  const postings: CrawledPosting[] = [];
  const seen = new Set<string>();
  let failures = 0;
  for (const result of settled) {
    if (result.status === "rejected") {
      failures += 1;
      continue;
    }
    for (const job of result.value) {
      const key = job.url || job.externalId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      postings.push(job);
    }
  }
  if (postings.length === 0 && failures === tasks.length) {
    throw new Error("Every public board failed");
  }
  cache = { at: Date.now(), postings };
  return postings;
}

function locatedIn(posting: CrawledPosting, place: string, region: Region | undefined): boolean {
  if (!place.trim()) return true;
  const where = `${posting.place} ${posting.title}`;
  if (mentionsPlace(where, place)) return true;
  if (!posting.place.trim()) return mentionsPlace(posting.description, place);
  return openInCountry(posting.place, place, region);
}

export function filterPublicBoards(
  postings: CrawledPosting[],
  query: { keywords: string; place: string; country: string; remoteOnly: boolean; postedWithinDays: number | null },
): CrawledPosting[] {
  const words = query.keywords.toLowerCase().split(/\s+/).filter((word) => word.length > 2);
  const zone = zoneByCode(query.country);
  const region: Region | undefined = zone ? zoneRegion(zone) : query.country ? COUNTRY_REGION[query.country] : undefined;
  const filtered = postings.filter((posting) => {
    const blob = `${posting.title} ${posting.company} ${posting.place} ${posting.description}`.toLowerCase();
    const located = `${posting.title} ${posting.place} ${posting.description}`;
    if (words.length > 0 && !words.every((word) => blob.includes(word))) return false;
    if (query.remoteOnly && !posting.remote && !blob.includes("remote")) return false;
    if (!locatedIn(posting, query.place, region)) return false;
    const areaText = zone?.area === "Remote" ? `${posting.title} ${posting.place}` : located;
    if (!query.place.trim() && zone && !matchesArea(areaText, posting.remote, zone.area)) return false;
    if (!query.place.trim() && !zone && !matchesCountry(located, posting.remote, region)) return false;
    if (query.postedWithinDays != null && posting.postedAt) {
      const age = (Date.now() - Date.parse(posting.postedAt)) / 86_400_000;
      if (age > query.postedWithinDays) return false;
    }
    return true;
  });
  return filtered.sort((a, b) => {
    const score = (item: CrawledPosting) => {
      const text = `${item.title} ${item.place} ${item.description}`;
      if (query.place.trim() && mentionsPlace(`${item.place} ${item.title}`, query.place)) return 2;
      if (region && detectRegions(text, item.remote).includes(region)) return 1;
      return 0;
    };
    return score(b) - score(a);
  });
}

/** One cheap request, for Settings → Test connection. */
export async function testPublicBoards(signal?: AbortSignal): Promise<void> {
  const endpoint = catalog.jobBoards.remotive;
  if (!endpoint) throw new Error("Add remotive to config/job-boards.json");
  await fetchRemotive(endpoint, "developer", withTimeout(signal));
}
