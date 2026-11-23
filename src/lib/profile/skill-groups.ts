// Skill groups: resumes print one labelled line per group
// ("Cloud & Infrastructure: GCP, AWS, Docker"). Ungrouped skills use "Other".

export type GroupedSkill = { name: string; group: string };

/** Commas (current) or middots (older tailored units) between skill names. */
const SKILL_SEP = /\s*·\s*|,\s*/;

/** Resume label for skills with no group. */
export const UNGROUPED_SKILLS_LABEL = "Other";

/** The groups and their skills, each group where its first skill is; skills without a group are the group "". */
export function skillGroups<T extends GroupedSkill>(skills: readonly T[]): { group: string; skills: T[] }[] {
  const groups = new Map<string, T[]>();
  for (const skill of skills) {
    const group = skill.group.trim();
    groups.set(group, [...(groups.get(group) ?? []), skill]);
  }
  return [...groups].map(([group, members]) => ({ group, skills: members }));
}

/** Skills as Profile → Skills shows them: those without a group first, then each group, where its first skill is. */
export function inEditorOrder<T extends GroupedSkill>(skills: readonly T[]): T[] {
  const groups = skillGroups(skills);
  return [...groups.filter(({ group }) => !group), ...groups.filter(({ group }) => group)].flatMap(({ skills: members }) => members);
}

/** One `Category: a, b, c` line per group; ungrouped skills last under {@link UNGROUPED_SKILLS_LABEL}. */
export function skillsText(skills: readonly GroupedSkill[]): string {
  const groups = skillGroups(skills);
  const named = groups.filter(({ group }) => group);
  const ungrouped = groups.find(({ group }) => !group)?.skills ?? [];
  const lines = named.map(({ group, skills: members }) => `${group}: ${members.map((skill) => skill.name).join(", ")}`);
  if (ungrouped.length > 0) {
    lines.push(`${UNGROUPED_SKILLS_LABEL}: ${ungrouped.map((skill) => skill.name).join(", ")}`);
  }
  return lines.join("\n");
}

const LABEL = /^([^:·\n]{1,60}):\s+/;

/** A line of the Skills unit, as its group's label (or none) and its skills. */
export function skillLine(line: string): { label: string | null; text: string } {
  const match = LABEL.exec(line);
  return match ? { label: match[1].trim(), text: line.slice(match[0].length) } : { label: null, text: line };
}

/** The skills named in the Skills unit, without the labels. */
export function skillNamesIn(text: string): string[] {
  return text
    .split("\n")
    .flatMap((line) => skillLine(line.trim()).text.split(SKILL_SEP))
    .map((name) => name.trim())
    .filter(Boolean);
}
