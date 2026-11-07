import { z } from "zod";

import { matchSchema, type Extracted, type Match } from "@/lib/applications/application-data";
import { experienceMonths, formatMonthYear, languageLevelLabel, sameName, type ProfileData } from "@/lib/profile/profile";

import { system, UNTRUSTED_POSTING, type Task } from "./prompt-parts";

export const MATCH_REQUIREMENTS_VERSION = "match-requirements@1";

// The model only says which profile skill or language each requirement is
// about; code decides covered, partial or gap from the profile itself, so the
// match is deterministic and explainable.
const answerSchema = z.object({
  matches: z.array(
    z.object({
      /** The requirement's number in the list. */
      requirement: z.number().int(),
      /** A skill from the profile's list, spelled as there, or null. */
      skill: z.string().nullable(),
      /** A language from the profile's list, or null. */
      language: z.string().nullable(),
    }),
  ),
});

const INSTRUCTIONS = `You compare a job's requirements with a candidate's skills and languages.

For each numbered requirement, answer which ONE of the candidate's skills it is about, if any, and which of the candidate's languages, if any. Copy names exactly as they appear in the candidate's lists. Match on meaning ("Strong prototyping skills in Figma" is about "Figma"; "Has built or maintained a design system" is about "Design systems"), but don't stretch: when no skill really fits, answer null. Answer every requirement once.`;

export type MatchInput = { requirements: Extracted["requirements"]; profile: ProfileData; today?: Date };

/**each requirement covered, partial or a gap, with its evidence. */
export const matchRequirements: Task<MatchInput, Match> = async (provider, { requirements, profile, today = new Date() }, { signal }) => {
  const needsModel = requirements.some((requirement) => requirement.kind !== "years");
  const answer = needsModel
    ? await provider.complete({
        system: system(INSTRUCTIONS, UNTRUSTED_POSTING),
        messages: [
          {
            role: "user",
            content: JSON.stringify(
              {
                requirements: requirements.map((requirement, index) => ({ number: index, text: requirement.text, kind: requirement.kind, skill: requirement.skill })),
                candidateSkills: profile.skills.map((skill) => skill.name),
                candidateLanguages: profile.languages.map((language) => language.name),
              },
              null,
              2,
            ),
          },
        ],
        schema: answerSchema,
        schemaName: "requirement_matches",
        creativity: "FAITHFUL",
        effort: "low",
        signal,
      })
    : { matches: [] };

  const mapped = new Map(answer.matches.map((match) => [match.requirement, match]));
  return {
    data: matchSchema.parse({
      items: requirements.map((requirement, index) => classify(requirement, mapped.get(index), profile, today)),
    }),
    promptVersion: MATCH_REQUIREMENTS_VERSION,
  };
};

type Item = Match["items"][number];

function classify(
  requirement: Extracted["requirements"][number],
  mapped: { skill: string | null; language: string | null } | undefined,
  profile: ProfileData,
  today: Date,
): Item {
  const base = { requirement: requirement.text, skill: null, experienceIds: [] as string[], note: null };

  if (requirement.kind === "years") {
    const dated = profile.experience.filter((entry) => entry.startYear !== null);
    if (dated.length === 0) return { ...base, result: "gap", note: "Add your experience to check this" };
    const first = dated.reduce(
      (earliest, entry) => (entry.startYear! * 12 + (entry.startMonth ?? 1) < earliest.startYear! * 12 + (earliest.startMonth ?? 1) ? entry : earliest),
      dated[0],
    );
    const count = profile.experience.length;
    const roles = `${count} ${count === 1 ? "role" : "roles"} in your profile, since ${formatMonthYear(first.startYear, first.startMonth)}`;
    const years = Math.floor(experienceMonths(profile, today) / 12);
    return years >= (requirement.years ?? 0)
      ? { ...base, result: "covered", note: roles }
      : { ...base, result: "gap", note: `${roles} (about ${years} ${years === 1 ? "year" : "years"})` };
  }

  const degree = coveringDegree(requirement.text, profile.education);
  if (degree) return { ...base, result: "covered", note: degree };
  if (asksForDegree(requirement.text)) {
    const listed = profile.education.some((item) => item.degree.trim() || item.notes.trim());
    return {
      ...base,
      result: "gap",
      note: listed ? "None of your degrees covers this" : "Nothing in your profile, so I'll address it honestly in the letter",
    };
  }

  // Names must be the profile's own: a model can't add a skill by misspelling one.
  const language = profile.languages.find(
    (entry) => (mapped?.language && sameName(entry.name, mapped.language)) || (requirement.language && sameName(entry.name, requirement.language)),
  );
  if (requirement.kind === "language" || (language && !mapped?.skill)) {
    return language
      ? { ...base, result: "covered", skill: language.name, note: `${language.name}: ${languageLevelLabel(language.level)}` }
      : { ...base, result: "gap", note: "Not in your profile" };
  }

  // The model's pick first, then the skill the posting names; spelling may differ a little.
  const skill =
    profile.skills.find((entry) => mapped?.skill && sameSkill(entry.name, mapped.skill)) ??
    profile.skills.find((entry) => requirement.skill && sameSkill(entry.name, requirement.skill));
  if (!skill) {
    return {
      ...base,
      result: "gap",
      note: requirement.kind === "skill" ? "Not in your profile yet" : "Nothing in your profile, so I'll address it honestly in the letter",
    };
  }
  const roles = profile.experience.filter((entry) => entry.skillIds.includes(skill.id));
  return roles.length > 0
    ? {
        ...base,
        result: "covered",
        skill: skill.name,
        experienceIds: roles.map((entry) => entry.id),
        note: `Used at ${[...new Set(roles.map((entry) => entry.company || entry.role))].join(", ")}`,
      }
    : { ...base, result: "partial", skill: skill.name, note: "In your skills, but not linked to a role yet" };
}

/**
 * Whether two skill names mean the same skill, forgiving case, punctuation
 * and a plural: "Design system" is "Design systems", "UX-research" is "UX research".
 */
export function sameSkill(a: string, b: string): boolean {
  const key = (name: string) =>
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(" ")
      .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))
      .join(" ");
  return key(a) === key(b);
}

// A bachelor's requirement is covered by the profile's own degrees. A Bachelor
// of Technology in Computer Science and Engineering is a bachelor's degree in
// computer science and in engineering, and it counts as a technical discipline.
const DEGREE_FIELDS: { ask: RegExp; have: RegExp }[] = [
  { ask: /computer science|\bcse\b/i, have: /computer science|\bcse\b/i },
  { ask: /information technology/i, have: /information technology/i },
  { ask: /\bengineering\b/i, have: /engineering|\bb\s?tech\b|bachelor of technology|\bb e\b/i },
  { ask: /\bmathematics\b|\bmaths?\b/i, have: /mathematics|\bmaths?\b/i },
  { ask: /information systems/i, have: /information systems/i },
];

function plain(text: string): string {
  return text.toLowerCase().replace(/[’']/g, "").replace(/[.]/g, " ").replace(/\s+/g, " ").trim();
}

function asksForDegree(text: string): boolean {
  const words = plain(text);
  return (
    /\b(bachelor|bachelors|master|masters|undergraduate|postgraduate|doctorate|ph\s?d|b\s?tech|m\s?tech|btech|mtech|b\s?eng|m\s?eng|b e|m e|ba|bs|ms)\b/.test(words) ||
    /\bdegree in\b/.test(words)
  );
}

/** The degree name that satisfies the requirement, or null when none does. Null also when the requirement is not about a degree. */
function coveringDegree(requirement: string, education: ProfileData["education"]): string | null {
  if (!asksForDegree(requirement)) return null;
  for (const entry of education) {
    const text = `${entry.degree} ${entry.notes}`;
    if (degreeFits(requirement, text)) return entry.degree.trim() || entry.notes.trim() || null;
  }
  return null;
}

function degreeFits(requirement: string, degree: string): boolean {
  const needed = minimumLevel(requirement);
  const level = degreeLevel(degree);
  if (level === null || (needed !== null && level < needed)) return false;
  const asked = DEGREE_FIELDS.filter((field) => field.ask.test(plain(requirement)));
  const equivalent = /equivalent|related field|related discipline|similar field|relevant field|technical discipline/.test(plain(requirement));
  if (asked.length === 0) return true;
  if (asked.some((field) => field.have.test(plain(degree)))) return true;
  return equivalent && isTechnical(degree);
}

function minimumLevel(text: string): number | null {
  const words = plain(text);
  const levels = [
    /\b(bachelor|bachelors|undergraduate|b\s?tech|btech|b e|b\s?sc|b\s?eng|ba|bs)\b/.test(words) ? 2 : null,
    /\b(master|masters|postgraduate|m\s?tech|m\s?sc|mba|m\s?eng|m e)\b/.test(words) ? 3 : null,
    /\b(ph\s?d|doctorate)\b/.test(words) ? 4 : null,
  ].filter((level): level is number => level !== null);
  return levels.length === 0 ? null : Math.min(...levels);
}

function degreeLevel(text: string): number | null {
  const words = plain(text);
  if (/\b(ph\s?d|doctorate|doctor of philosophy)\b/.test(words)) return 4;
  if (/\b(master|masters|m\s?tech|m\s?sc|m e|mba|postgraduate)\b/.test(words)) return 3;
  if (/\b(bachelor|bachelors|undergraduate|b\s?tech|btech|b e|b\s?sc|b\s?eng|ba|bs|bachelor of technology)\b/.test(words)) return 2;
  return null;
}

function isTechnical(text: string): boolean {
  const words = plain(text);
  return /\b(computer|computing|software|information technology|engineering|technology|electronics|electrical|mechanical|civil|mathematics|maths|physics|data science|information systems)\b/.test(words);
}
