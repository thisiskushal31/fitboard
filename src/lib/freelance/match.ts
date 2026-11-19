import type { ProfileData } from "@/lib/profile/profile";
import { reach, type Place } from "@/lib/startups/place";

import type { FoundFreelance } from "./types";

// Freelance match: profile fit 0–100 for a gig against skills and place.

export const MATCH_VERSION = "freelance-match@1";

const GENERIC =
  /^(agile|scrum|kanban|git|github|gitlab|jira|confluence|slack|ci\/cd( pipelines)?|communication|teamwork|leadership|problem solving|ms office|microsoft office|excel|english)$/i;

const FIELDS: { name: string; profile: RegExp; gig: RegExp }[] = [
  { name: "mobile", profile: /\b(android|ios|kotlin|swift|react native|flutter|mobile)\b/i, gig: /\b(android|ios|mobile|kotlin|swift|react native|flutter)\b/i },
  { name: "frontend", profile: /\b(react|next\.?js|vue|angular|svelte|typescript|frontend|front-end)\b/i, gig: /\b(frontend|front-end|react|next\.?js|vue|angular|svelte)\b/i },
  { name: "backend", profile: /\b(node\.?js|express|django|rails|spring|golang|rust|postgres|mongodb|backend|back-end|graphql)\b/i, gig: /\b(backend|back-end|node\.?js|api|golang|rust)\b/i },
  { name: "infrastructure", profile: /\b(devops|sre|kubernetes|terraform|aws|gcp|azure|infrastructure)\b/i, gig: /\b(devops|sre|site reliability|kubernetes|infrastructure|platform)\b/i },
  { name: "data and AI", profile: /\b(python|machine learning|ml|pytorch|tensorflow|data science|llm|nlp)\b/i, gig: /\b(machine learning|ml engineer|ai engineer|data scientist|llm|nlp)\b/i },
  { name: "design", profile: /\b(figma|ux|ui design|product design|designer)\b/i, gig: /\b(designer|product design|ux|ui\/ux)\b/i },
];

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function skillPattern(skill: string): RegExp {
  const spelled = escape(skill.toLowerCase()).replace(/\\\.(?=js\b)/, "\\.?").replace(/\s+/g, "[\\s-]?");
  return new RegExp(`(^|[^a-z0-9+#])${spelled}($|[^a-z0-9+#])`, "i");
}

const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);

export type FreelanceFit = { score: number; reasons: string[] };

/** How well `gig` fits the profile, with short reasons. */
export function matchFreelance(
  gig: FoundFreelance,
  profile: Pick<ProfileData, "basics" | "skills" | "experience">,
  place: Place,
  now = new Date(),
): FreelanceFit {
  const text = [gig.title, gig.company, gig.description, gig.place, gig.budget, gig.duration].join("\n");
  const reasons: string[] = [];
  let score = 12;

  const skills = profile.skills.map((skill) => skill.name.trim()).filter((name) => name.length > 1 && !GENERIC.test(name));
  const hits = skills.filter((skill) => skillPattern(skill).test(text));
  score += Math.min(40, hits.slice(0, 2).length * 12 + hits.slice(2).length * 5);
  if (hits.length > 0) reasons.push(`Mentions ${list(hits.slice(0, 4))} from your skills`);

  const profileText = [profile.basics.headline, profile.basics.summary, ...profile.experience.map((role) => role.role), ...skills].join(" ");
  const field = FIELDS.find((entry) => entry.profile.test(profileText) && entry.gig.test(text));
  if (field) {
    score += 15;
    reasons.push(`Needs ${field.name} work, like yours`);
  } else if (/\b(engineer|developer|designer|writer|consultant)\b/i.test(text)) {
    score += 5;
  }

  const where = reach(`${gig.place} ${gig.title}`, place);
  if (where.here === "city") {
    score += 18;
    reasons.push(`In ${place.city}`);
  } else if (where.here === "country") {
    score += 10;
    reasons.push(`In ${place.countryName}`);
  }
  if (gig.remote || where.remote) {
    if (where.remoteOpen === true || !place.country) {
      score += 12;
      reasons.push(place.countryName ? `Remote, open to ${place.countryName}` : "Remote");
    } else if (where.remoteOpen === null) {
      score += 6;
      reasons.push("Remote (where from isn't said)");
    }
  }

  const days = gig.postedAt ? (now.getTime() - Date.parse(gig.postedAt)) / 86_400_000 : Infinity;
  if (days <= 14) {
    score += 10;
    reasons.push(days < 1 ? "Posted today" : days < 2 ? "Posted yesterday" : `Posted ${Math.round(days)} days ago`);
  } else if (days <= 45) {
    score += 5;
  }

  if (gig.budget.trim()) {
    score += 5;
    reasons.push("Lists a budget");
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons };
}
