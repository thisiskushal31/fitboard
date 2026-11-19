import { z } from "zod";

// Engagement → Events: tech conferences and meetups from public sources,
// ranked by place proximity then profile fit. Shared by the server and the screen.

export const EVENT_SOURCES = ["TECHCONF", "TECHMEETUPS", "CONFSTECH", "MEETUP"] as const;
export type EventSource = (typeof EVENT_SOURCES)[number];

export const EVENT_SOURCE_INFO: Record<EventSource, { name: string; kind: string }> = {
  TECHCONF: { name: "TechConf.Directory", kind: "Tech conferences" },
  TECHMEETUPS: { name: "TechMeetups", kind: "Conferences" },
  CONFSTECH: { name: "confs.tech", kind: "Tech conferences" },
  MEETUP: { name: "Meetup", kind: "Local groups" },
};

export const EVENT_STATUSES = ["NEW", "SAVED", "DISMISSED"] as const;
export type EventStatusName = (typeof EVENT_STATUSES)[number];

export const EVENT_FORMATS = ["IN_PERSON", "VIRTUAL", "HYBRID", "UNKNOWN"] as const;
export type EventFormatName = (typeof EVENT_FORMATS)[number];

export const EVENT_FORMAT_LABEL: Record<EventFormatName, string> = {
  IN_PERSON: "In person",
  VIRTUAL: "Virtual",
  HYBRID: "Hybrid",
  UNKNOWN: "Format unknown",
};

/** An event as a source found it. */
export type FoundEvent = {
  source: EventSource;
  externalId: string;
  title: string;
  summary: string;
  url: string;
  place: string;
  city: string;
  country: string;
  remote: boolean | null;
  format: EventFormatName;
  startsAt: string | null;
  endsAt: string | null;
  ticketPrice: string;
  speakers: string[];
  attendance: number | null;
  audience: string;
};

/** An event as the screen sees it. */
export type EventView = FoundEvent & {
  id: string;
  score: number;
  proximity: number;
  reasons: string[];
  status: EventStatusName;
  notes: string;
};

export const EVENT_PLACES = ["any", "city", "country", "remote"] as const;
export type EventPlace = (typeof EVENT_PLACES)[number];

export const EVENT_SORTS = ["nearby", "soon", "match"] as const;

export const eventFilterSchema = z.object({
  q: z.string().trim().max(200).default(""),
  place: z.enum(EVENT_PLACES).default("any"),
  source: z.enum(EVENT_SOURCES).or(z.literal("")).default(""),
  format: z.enum(EVENT_FORMATS).or(z.literal("")).default(""),
  minScore: z.coerce.number().int().min(0).max(100).default(0),
  status: z.enum(EVENT_STATUSES).default("NEW"),
  sort: z.enum(EVENT_SORTS).default("nearby"),
});
export type EventFilter = z.output<typeof eventFilterSchema>;

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value) ?? "";

/** The filter in the Events screen's address. */
export function eventFilterFromParams(params: Record<string, string | string[] | undefined>): EventFilter {
  const parsed = eventFilterSchema.safeParse({
    q: one(params.q),
    place: one(params.place) || undefined,
    source: one(params.source).toUpperCase(),
    format: one(params.format).toUpperCase(),
    minScore: one(params.min) || undefined,
    status: one(params.view).toUpperCase() || undefined,
    sort: one(params.sort) || undefined,
  });
  return parsed.success ? parsed.data : eventFilterSchema.parse({});
}

/** The Events screen's address for a filter, leaving out the defaults. */
export function eventFilterHref(filter: EventFilter): string {
  const params = new URLSearchParams();
  if (filter.q) params.set("q", filter.q);
  if (filter.place !== "any") params.set("place", filter.place);
  if (filter.source) params.set("source", filter.source.toLowerCase());
  if (filter.format) params.set("format", filter.format.toLowerCase());
  if (filter.minScore > 0) params.set("min", String(filter.minScore));
  if (filter.status !== "NEW") params.set("view", filter.status.toLowerCase());
  if (filter.sort !== "nearby") params.set("sort", filter.sort);
  const query = params.toString();
  return query ? `/events?${query}` : "/events";
}

const sourceResult = z.object({ source: z.enum(EVENT_SOURCES), found: z.number().int(), error: z.string().nullable() });

/** What the last refresh found, kept in Settings for the screen. */
export const eventsRefreshSchema = z.object({
  at: z.string(),
  added: z.number().int(),
  sources: z.array(sourceResult),
});
export type EventsRefresh = z.infer<typeof eventsRefreshSchema>;
