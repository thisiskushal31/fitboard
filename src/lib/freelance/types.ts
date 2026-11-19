import { z } from "zod";

// Engagement → Freelance: contract, project, and temporary gigs from public
// sources, ranked against the profile. Shared by the server and the screen.

export const FREELANCE_SOURCES = ["HN", "REMOTIVE", "WWR", "FREELANCER", "REMOTEOK"] as const;
export type FreelanceSource = (typeof FREELANCE_SOURCES)[number];

export const FREELANCE_SOURCE_INFO: Record<FreelanceSource, { name: string; kind: string }> = {
  HN: { name: "Hacker News", kind: "Seeking freelancer" },
  REMOTIVE: { name: "Remotive", kind: "Contract / freelance" },
  WWR: { name: "We Work Remotely", kind: "Contract" },
  FREELANCER: { name: "Freelancer.com", kind: "Client projects" },
  REMOTEOK: { name: "Remote OK", kind: "Contract / freelance" },
};

export const FREELANCE_STATUSES = ["NEW", "SAVED", "CONTACTED", "DISMISSED"] as const;
export type FreelanceStatusName = (typeof FREELANCE_STATUSES)[number];

export const FREELANCE_ENGAGEMENTS = ["CONTRACT", "PROJECT", "TEMPORARY"] as const;
export type FreelanceEngagementName = (typeof FREELANCE_ENGAGEMENTS)[number];

export const FREELANCE_ENGAGEMENT_LABEL: Record<FreelanceEngagementName, string> = {
  CONTRACT: "Contract",
  PROJECT: "Project",
  TEMPORARY: "Temporary",
};

/** A gig as a source found it. */
export type FoundFreelance = {
  source: FreelanceSource;
  externalId: string;
  title: string;
  company: string;
  place: string;
  remote: boolean | null;
  engagement: FreelanceEngagementName;
  budget: string;
  duration: string;
  url: string;
  description: string;
  postedAt: string | null;
};

/** A gig as the screen sees it. */
export type FreelanceView = FoundFreelance & {
  id: string;
  score: number;
  reasons: string[];
  status: FreelanceStatusName;
  notes: string;
  applicationId: string | null;
};

export const FREELANCE_PLACES = ["any", "city", "country", "remote"] as const;
export type FreelancePlace = (typeof FREELANCE_PLACES)[number];

export const FREELANCE_SORTS = ["match", "newest"] as const;

export const freelanceFilterSchema = z.object({
  q: z.string().trim().max(200).default(""),
  place: z.enum(FREELANCE_PLACES).default("any"),
  source: z.enum(FREELANCE_SOURCES).or(z.literal("")).default(""),
  engagement: z.enum(FREELANCE_ENGAGEMENTS).or(z.literal("")).default(""),
  minScore: z.coerce.number().int().min(0).max(100).default(0),
  status: z.enum(FREELANCE_STATUSES).default("NEW"),
  sort: z.enum(FREELANCE_SORTS).default("match"),
});
export type FreelanceFilter = z.output<typeof freelanceFilterSchema>;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/** The filter in the Freelance screen's address. */
export function freelanceFilterFromParams(params: Record<string, string | string[] | undefined>): FreelanceFilter {
  const parsed = freelanceFilterSchema.safeParse({
    q: one(params.q),
    place: one(params.place) || undefined,
    source: one(params.source).toUpperCase(),
    engagement: one(params.type).toUpperCase(),
    minScore: one(params.min) || undefined,
    status: one(params.view).toUpperCase() || undefined,
    sort: one(params.sort) || undefined,
  });
  return parsed.success ? parsed.data : freelanceFilterSchema.parse({});
}

/** The Freelance screen's address for a filter, leaving out the defaults. */
export function freelanceFilterHref(filter: FreelanceFilter): string {
  const params = new URLSearchParams();
  if (filter.q) params.set("q", filter.q);
  if (filter.place !== "any") params.set("place", filter.place);
  if (filter.source) params.set("source", filter.source.toLowerCase());
  if (filter.engagement) params.set("type", filter.engagement.toLowerCase());
  if (filter.minScore > 0) params.set("min", String(filter.minScore));
  if (filter.status !== "NEW") params.set("view", filter.status.toLowerCase());
  if (filter.sort !== "match") params.set("sort", filter.sort);
  const query = params.toString();
  return query ? `/freelance?${query}` : "/freelance";
}

const sourceResult = z.object({ source: z.enum(FREELANCE_SOURCES), found: z.number().int(), error: z.string().nullable() });

/** What the last refresh found, kept in Settings for the screen. */
export const freelanceRefreshSchema = z.object({
  at: z.string(),
  added: z.number().int(),
  sources: z.array(sourceResult),
});
export type FreelanceRefresh = z.infer<typeof freelanceRefreshSchema>;
