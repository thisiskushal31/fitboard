import type { ProfileData } from "@/lib/profile/profile";
import { reach, type Place } from "@/lib/startups/place";

import type { FoundEvent } from "./types";

// Events match: profile fit 0–100 and place proximity 0–3
// (city → country → virtual → elsewhere).

export const MATCH_VERSION = "events-match@1";

/** Same city. */
export const PROXIMITY_CITY = 0;
/** Same country. */
export const PROXIMITY_COUNTRY = 1;
/** Virtual / hybrid open worldwide. */
export const PROXIMITY_VIRTUAL = 2;
/** Elsewhere. */
export const PROXIMITY_FAR = 3;

const GENERIC =
  /^(agile|scrum|kanban|git|github|gitlab|jira|confluence|slack|ci\/cd( pipelines)?|communication|teamwork|leadership|problem solving|ms office|microsoft office|excel|english)$/i;

const FIELDS: { name: string; profile: RegExp; event: RegExp }[] = [
  { name: "mobile", profile: /\b(android|ios|kotlin|swift|react native|flutter|mobile)\b/i, event: /\b(android|ios|mobile|kotlin|swift|react native|flutter)\b/i },
  { name: "frontend", profile: /\b(react|next\.?js|vue|angular|svelte|typescript|frontend|front-end)\b/i, event: /\b(frontend|front-end|react|next\.?js|vue|angular|svelte|web)\b/i },
  { name: "backend", profile: /\b(node\.?js|express|django|rails|spring|golang|rust|postgres|mongodb|backend|back-end|graphql)\b/i, event: /\b(backend|back-end|node\.?js|api|golang|rust)\b/i },
  { name: "infrastructure", profile: /\b(devops|sre|kubernetes|terraform|aws|gcp|azure|infrastructure)\b/i, event: /\b(devops|sre|site reliability|kubernetes|infrastructure|platform|cloud)\b/i },
  { name: "data and AI", profile: /\b(python|machine learning|ml|pytorch|tensorflow|data science|llm|nlp|ai)\b/i, event: /\b(machine learning|ml|ai|data science|llm|nlp|artificial intelligence)\b/i },
  { name: "design", profile: /\b(figma|ux|ui design|product design|designer)\b/i, event: /\b(designer|product design|ux|ui\/ux|design)\b/i },
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function skillPattern(skill: string): RegExp {
  const spelled = escape(skill.toLowerCase()).replace(/\\\.(?=js\b)/, "\\.?").replace(/\s+/g, "[\\s-]?");
  return new RegExp(`(^|[^a-z0-9+#])${spelled}($|[^a-z0-9+#])`, "i");
}

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export type EventFit = { score: number; proximity: number; reasons: string[] };

/** Proximity tier for an event against the profile place. */
export function eventProximity(event: Pick<FoundEvent, "place" | "city" | "country" | "remote" | "format" | "title" | "summary">, place: Place): number {
  const blob = `${event.place} ${event.city} ${event.country} ${event.title}`;
  const where = reach(blob, place);
  if (where.here === "city") return PROXIMITY_CITY;
  if (where.here === "country") return PROXIMITY_COUNTRY;
  const virtual = event.format === "VIRTUAL" || event.format === "HYBRID" || event.remote === true || where.remote;
  if (virtual && (where.remoteOpen !== false || !place.country)) return PROXIMITY_VIRTUAL;
  return PROXIMITY_FAR;
}

/** How well `event` fits the profile, with proximity and short reasons. */
export function matchEvent(
  event: FoundEvent,
  profile: Pick<ProfileData, "basics" | "skills" | "experience">,
  place: Place,
  now = new Date(),
): EventFit {
  const text = [event.title, event.summary, event.place, event.city, ...(event.speakers ?? [])].join("\n");
  const reasons: string[] = [];
  let score = 12;
  const proximity = eventProximity(event, place);

  if (proximity === PROXIMITY_CITY) {
    score += 28;
    reasons.push(place.city ? `In ${place.city}` : "Near you");
  } else if (proximity === PROXIMITY_COUNTRY) {
    score += 16;
    reasons.push(place.countryName ? `In ${place.countryName}` : "In your country");
  } else if (proximity === PROXIMITY_VIRTUAL) {
    score += 12;
    reasons.push(place.countryName ? `Virtual, open to ${place.countryName}` : "Virtual");
  }

  const skills = profile.skills.map((skill) => skill.name.trim()).filter((name) => name.length > 1 && !GENERIC.test(name));
  const hits = skills.filter((skill) => skillPattern(skill).test(text));
  score += Math.min(40, hits.slice(0, 2).length * 12 + hits.slice(2).length * 5);
  if (hits.length > 0) reasons.push(`Covers ${list(hits.slice(0, 4))} from your skills`);

  const profileText = [profile.basics.headline, profile.basics.summary, ...profile.experience.map((role) => role.role), ...skills].join(" ");
  const field = FIELDS.find((entry) => entry.profile.test(profileText) && entry.event.test(text));
  if (field) {
    score += 15;
    reasons.push(`About ${field.name}, like your work`);
  } else if (/\b(engineer|developer|design|product|startup|tech)\b/i.test(text)) {
    score += 5;
  }

  if (event.startsAt) {
    const days = (Date.parse(event.startsAt) - now.getTime()) / 86_400_000;
    if (days >= 0 && days <= 30) {
      score += 10;
      reasons.push(days < 1 ? "Starts today" : days < 2 ? "Starts tomorrow" : `Starts in ${Math.round(days)} days`);
    } else if (days > 30 && days <= 90) {
      score += 5;
    } else if (days < 0) {
      score -= 20;
    }
  }

  if (event.ticketPrice.trim()) score += 3;
  if (event.speakers.length > 0) score += 3;

  return { score: Math.max(0, Math.min(100, Math.round(score))), proximity, reasons };
}
