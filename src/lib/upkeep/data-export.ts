import "server-only";

import { z } from "zod";

import type { PrismaClient } from "@/generated/prisma/client";
import {
  AgentCandidateStatus,
  ApplicationOrigin,
  ApplicationStatus,
  ChatRole,
  DateStyle,
  Density,
  DocumentKind,
  FunnelStage,
  HeaderStyle,
  HeadingStyle,
  LanguageLevel,
  PhotoPosition,
  PhotoShape,
  PostingSource,
  SidebarStyle,
  StartupStatus,
  ThemeAlign,
  ThemeFont,
  ThemeLayout,
  Tone,
  VersionCause,
} from "@/generated/prisma/enums";
import { decryptApiKey } from "@/lib/ai/api-key";
import { decryptSecret, JOB_SOURCE_KEY } from "@/lib/core/secrets";
import { appVersion } from "@/lib/upkeep/version";

// Everything a user keeps in Fitboard as one JSON file: the
// profile, custom themes, settings and applications with their history,
// documents, chat and notes, the postings kept from Find jobs and
// the job agent's candidates, so its dedupe survives a restore, and
// Startups with what the user did with them.
// IDs are kept, so an import restores every link. Jobs, sign-in throttling,
// built-in themes, the Google account and the mail fetched from Gmail stay
// behind: they belong to the server or the mailbox, not the user's data.

export const EXPORT_FORMAT = "fitboard-export";
/** Bump when the file's shape changes; imports refuse versions they don't know. 2 added Find jobs' postings and keys, 3 projects and the job agent, 4 facts, 5 publications, the profile photo's theme and application options and Startups, 6 the line about a role's company, 7 skill groups. */
export const EXPORT_SCHEMA_VERSION = 7;
/** The versions imports can read. */
export const EXPORT_SCHEMA_VERSIONS: readonly number[] = [1, 2, 3, 4, 5, 6, 7];

/** The setting that holds the encrypted API key, which only this server can read. */
const API_KEY_SETTING = "apiKeyEnc";
/** The settings that hold encrypted keys, which only this server can read: never exported as they are. */
export const SECRET_SETTINGS: readonly string[] = [API_KEY_SETTING, "jsearchKeyEnc", "adzunaKeyEnc", "typesafeKeyEnc"];
/** The settings that belong to this install rather than its data (the usage ping's and its consent, the update check's, the Google client and the browser's time zone): never exported, and kept by an import. */
export const INSTALL_SETTINGS: readonly string[] = [
  "usagePingId",
  "usagePingDay",
  "usagePingChoice",
  "usagePingChoiceAt",
  "usagePingChoiceText",
  // The job agent's runs count against this server's job source key.
  "agentRuns",
  // When Startups was last opened and what its last refresh found.
  "startupsViewedAt",
  "startupsLastRefresh",
  "latestVersion",
  "latestVersionUrl",
  "updateCheckDay",
  "updateDismissed",
  "googleClientId",
  "googleClientSecretEnc",
  "browserTimeZone",
  // An import must never open the MCP connector's addresses on this server, or let another app sign in.
  "connectorEnabledAt",
  "connectorRedirects",
];

const date = z.iso.datetime().transform((value) => new Date(value));
const optionalDate = date.nullable();
const int = z.number().int();
const text = z.string();

// Groups came in version 7; older files have none.
const skill = z.object({ id: text, name: text, sort: int, group: text.default(""), createdAt: date });
const language = z.object({ id: text, name: text, level: z.enum(LanguageLevel), sort: int, createdAt: date });
const span = {
  startYear: int.nullable(),
  startMonth: int.nullable(),
  endYear: int.nullable(),
  endMonth: int.nullable(),
  current: z.boolean(),
};
const experience = z.object({
  id: text,
  role: text,
  company: text,
  location: text,
  /** Absent in files before version 6. */
  descriptor: text.optional(),
  ...span,
  bullets: text,
  sort: int,
  /** The skills used in the role. */
  skillIds: z.array(text),
  createdAt: date,
  updatedAt: date,
});
const project = z.object({
  id: text,
  name: text,
  link: text,
  ...span,
  bullets: text,
  sort: int,
  /** The skills used in the project. */
  skillIds: z.array(text),
  createdAt: date,
  updatedAt: date,
});
const education = z.object({ id: text, degree: text, school: text, ...span, notes: text, sort: int, createdAt: date, updatedAt: date });
/** A publication: its citation as written, with **bold** and *italic*. */
const publication = z.object({ id: text, citation: text, link: text, onResumes: z.boolean(), sort: int, createdAt: date, updatedAt: date });
const reference = z.object({
  id: text,
  name: text,
  relation: text,
  company: text,
  email: text,
  phone: text,
  sort: int,
  createdAt: date,
  updatedAt: date,
});
/** A fact for the AI, the profile's or an application's. */
const fact = z.object({ id: text, text, sort: int, createdAt: date, updatedAt: date });
const theme = z.object({
  id: text,
  name: text,
  headFont: z.enum(ThemeFont),
  bodyFont: z.enum(ThemeFont),
  accent: text,
  layout: z.enum(ThemeLayout),
  align: z.enum(ThemeAlign),
  headingStyle: z.enum(HeadingStyle),
  density: z.enum(Density),
  /** Absent in older files, which take the defaults. */
  headerStyle: z.enum(HeaderStyle).optional(),
  sidebarStyle: z.enum(SidebarStyle).optional(),
  dateStyle: z.enum(DateStyle).optional(),
  /** Absent before 1.9.0. */
  photoShape: z.enum(PhotoShape).optional(),
  photoPosition: z.enum(PhotoPosition).optional(),
  createdAt: date,
  updatedAt: date,
});
const keyValue = z.object({ key: text, value: text });

const statusEvent = z.object({
  id: text,
  from: z.enum(ApplicationStatus),
  to: z.enum(ApplicationStatus),
  at: date,
  previousFurthestStage: z.enum(FunnelStage).nullable(),
  previousSentAt: optionalDate,
});
const document = z.object({
  id: text,
  kind: z.enum(DocumentKind),
  units: z.unknown(),
  themeId: text.nullable(),
  writtenWith: text.nullable(),
  /** Parts left out to fit the page limit; absent in older files. */
  trimmed: z.unknown().nullable().optional(),
  /** Earlier versions; absent in older files. */
  versions: z
    .array(z.object({ id: text, units: z.unknown(), cause: z.enum(VersionCause), detail: text, createdAt: date }))
    .optional(),
  updatedAt: date,
});
const chatMessage = z.object({
  id: text,
  role: z.enum(ChatRole),
  text,
  targetUnit: text.nullable(),
  edits: z.unknown().nullable(),
  undone: z.boolean(),
  previousTone: z.enum(Tone).nullable(),
  writtenWith: text.nullable(),
  createdAt: date,
});
const note = z.object({ id: text, body: text, createdAt: date, updatedAt: date });
const application = z.object({
  id: text,
  title: text,
  company: text,
  role: text,
  location: text,
  mode: text,
  salary: text,
  deadline: optionalDate,
  postingUrl: text,
  postingText: text,
  extracted: z.unknown().nullable(),
  extractedWith: text.nullable(),
  match: z.unknown().nullable(),
  matchedWith: text.nullable(),
  status: z.enum(ApplicationStatus),
  furthestStage: z.enum(FunnelStage).nullable(),
  sentAt: optionalDate,
  /** The next interview; absent in older files. */
  nextInterviewAt: optionalDate.optional(),
  tone: z.enum(Tone),
  /** "Anything I should know?" in files before version 4; read as the application's first fact. */
  userNote: text.optional(),
  language: text,
  followThemeLayout: z.boolean(),
  /** Absent before 1.9.0, which follows the profile. */
  showPhoto: z.boolean().nullable().optional(),
  /** Where the application came from. Absent in older files, which hold only the user's own. */
  origin: z.enum(ApplicationOrigin).optional(),
  agentScore: int.nullable().optional(),
  awaitingReview: z.boolean().optional(),
  archivedAt: optionalDate,
  createdAt: date,
  updatedAt: date,
  events: z.array(statusEvent),
  documents: z.array(document),
  messages: z.array(chatMessage),
  notes: z.array(note),
  /** Absent in files before version 4. */
  facts: z.array(fact).default([]),
});

/** A posting the job agent found. */
const agentCandidate = z.object({
  id: text,
  source: z.enum(PostingSource),
  externalId: text,
  title: text,
  company: text,
  place: text,
  remote: z.boolean().nullable(),
  salary: text,
  postedAt: optionalDate,
  url: text,
  via: text,
  description: text,
  complete: z.boolean(),
  score: int,
  reasons: z.unknown().nullable(),
  redFlags: z.unknown().nullable(),
  status: z.enum(AgentCandidateStatus),
  error: text.nullable(),
  applicationId: text.nullable(),
  dedupeKey: text,
  createdAt: date,
  updatedAt: date,
});

/** A startup from Startups, with the addresses it publishes and what the user did with it. */
const startup = z.object({
  id: text,
  source: text,
  externalId: text,
  company: text,
  website: text,
  summary: text,
  details: text,
  location: text,
  remote: z.boolean().nullable(),
  stage: text,
  roles: z.unknown().nullable(),
  emails: z.unknown().nullable(),
  links: z.unknown().nullable(),
  postedAt: optionalDate,
  score: int,
  reasons: z.unknown().nullable(),
  scoredWith: text,
  status: z.enum(StartupStatus),
  noApplicationsFrom: text,
  emailsCheckedAt: optionalDate,
  peopleCheckedAt: optionalDate,
  notes: text,
  seenAt: date,
  applicationId: text.nullable(),
  createdAt: date,
  updatedAt: date,
});

/** A posting kept from Find jobs. */
const posting = z.object({
  id: text,
  source: z.enum(PostingSource),
  externalId: text,
  title: text,
  company: text,
  place: text,
  remote: z.boolean().nullable(),
  salary: text,
  postedAt: optionalDate,
  url: text,
  via: text,
  description: text,
  complete: z.boolean(),
  savedAt: optionalDate,
  dismissedAt: optionalDate,
  applicationId: text.nullable(),
  createdAt: date,
  updatedAt: date,
});

/** A search kept with what it found; its search and postings are checked when it's opened. */
const postingSearch = z.object({
  id: text,
  source: z.enum(PostingSource),
  query: z.unknown(),
  postings: z.unknown(),
  found: int,
  next: text.nullable(),
  createdAt: date,
  updatedAt: date,
});

/** An export file as read back. */
export const exportSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  schemaVersion: z.literal([1, 2, 3, 4, 5, 6, 7]),
  appVersion: text,
  exportedAt: date,
  profile: z.object({
    fields: z.array(keyValue),
    skills: z.array(skill),
    languages: z.array(language),
    experience: z.array(experience),
    /** Absent in files before version 3. */
    projects: z.array(project).default([]),
    education: z.array(education),
    /** Absent in files before version 5. */
    publications: z.array(publication).default([]),
    references: z.array(reference),
    /** Absent in files before version 4. */
    facts: z.array(fact).default([]),
  }),
  themes: z.array(theme),
  settings: z.array(keyValue),
  /** The AI provider's key in plain text, only when the user asked for it. */
  apiKey: text.optional(),
  /** The job sources' keys in plain text, likewise. */
  jobSourceKeys: z.object({ jsearch: text.optional(), adzuna: text.optional() }).optional(),
  applications: z.array(application),
  /** Saved and dismissed postings; absent in version 1 files. */
  postings: z.array(posting).default([]),
  /** Past searches with what they found; absent in version 1 files. */
  searches: z.array(postingSearch).default([]),
  /** The job agent's candidates; absent in older files. */
  agentCandidates: z.array(agentCandidate).default([]),
  /** Startups, and hashes of the ones removed for good; absent in older files. */
  startups: z.array(startup).default([]),
  startupBlocks: z.array(z.object({ hash: text, createdAt: date })).default([]),
});
export type FitboardExport = z.infer<typeof exportSchema>;

/** "fitboard-export-2026-09-28.json", dated in the server's time zone. */
export function exportFileName(now = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `fitboard-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/**
 * Collects everything into an export. The API key is left out,
 * unless `includeApiKey`: then it's decrypted, since another server's
 * FITBOARD_SECRET couldn't read the encrypted copy. One read-only
 * transaction, so the export is a consistent snapshot. Also used for
 * backups.
 */
export async function buildExport(
  db: PrismaClient,
  { includeApiKey = false, now = new Date() }: { includeApiKey?: boolean; now?: Date } = {},
): Promise<FitboardExport> {
  return db.$transaction(async (tx) => {
    const [fields, skills, languages, experience, projects, education, publications, references, facts, themes, settings, applications, postings, searches, agentCandidates, startups, startupBlocks] = await Promise.all([
      tx.profileField.findMany({ select: { key: true, value: true }, orderBy: { key: "asc" } }),
      tx.skill.findMany({ select: { id: true, name: true, sort: true, group: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
      tx.language.findMany({ select: { id: true, name: true, level: true, sort: true, createdAt: true }, orderBy: { createdAt: "asc" } }),
      tx.experience.findMany({ include: { skills: { select: { skillId: true } } }, orderBy: { createdAt: "asc" } }),
      tx.project.findMany({ include: { skills: { select: { skillId: true } } }, orderBy: { createdAt: "asc" } }),
      tx.education.findMany({ orderBy: { createdAt: "asc" } }),
      tx.publication.findMany({ orderBy: [{ sort: "asc" }, { createdAt: "asc" }] }),
      tx.reference.findMany({ orderBy: { createdAt: "asc" } }),
      tx.fact.findMany({ where: { applicationId: null }, omit: { applicationId: true }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] }),
      tx.theme.findMany({ where: { builtIn: false }, omit: { builtIn: true }, orderBy: { createdAt: "asc" } }),
      tx.setting.findMany({ select: { key: true, value: true }, orderBy: { key: "asc" } }),
      tx.application.findMany({
        orderBy: { createdAt: "asc" },
        // The Gmail thread belongs to the mailbox, not the data.
        omit: { emailThreadId: true, interviewEventId: true, interviewCalendarId: true },
        include: {
          events: { omit: { applicationId: true }, orderBy: { at: "asc" } },
          documents: {
            omit: { applicationId: true },
            orderBy: { kind: "asc" },
            include: { versions: { omit: { documentId: true }, orderBy: { createdAt: "asc" } } },
          },
          messages: { omit: { applicationId: true }, orderBy: { createdAt: "asc" } },
          notes: { omit: { applicationId: true }, orderBy: { createdAt: "asc" } },
          facts: { omit: { applicationId: true }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] },
        },
      }),
      tx.posting.findMany({ orderBy: { createdAt: "asc" } }),
      tx.postingSearch.findMany({ orderBy: { createdAt: "asc" } }),
      tx.agentCandidate.findMany({ orderBy: { createdAt: "asc" } }),
      tx.startup.findMany({ orderBy: { createdAt: "asc" } }),
      tx.startupBlock.findMany({ orderBy: { createdAt: "asc" } }),
    ]);

    // Keys only when asked for, decrypted; one that's unreadable here too (FITBOARD_SECRET changed) has nothing to export.
    const stored = (key: string) => (includeApiKey ? settings.find((setting) => setting.key === key)?.value : undefined);
    const readable = (value: string | undefined, decrypt: (value: string) => string) => {
      try {
        return value ? decrypt(value) : undefined;
      } catch {
        return undefined;
      }
    };
    const apiKey = readable(stored(API_KEY_SETTING), (value) => decryptApiKey(value));
    const jobSourceKeys = Object.fromEntries(
      Object.entries({
        jsearch: readable(stored("jsearchKeyEnc"), (value) => decryptSecret(JOB_SOURCE_KEY, value)),
        adzuna: readable(stored("adzunaKeyEnc"), (value) => decryptSecret(JOB_SOURCE_KEY, value)),
      }).filter(([, value]) => value),
    );

    return {
      format: EXPORT_FORMAT,
      schemaVersion: EXPORT_SCHEMA_VERSION,
      appVersion,
      exportedAt: now,
      profile: {
        fields,
        skills,
        languages,
        experience: experience.map(({ skills: links, ...entry }) => ({ ...entry, skillIds: links.map((link) => link.skillId) })),
        projects: projects.map(({ skills: links, ...entry }) => ({ ...entry, skillIds: links.map((link) => link.skillId) })),
        education,
        publications,
        references,
        facts,
      },
      themes,
      settings: settings.filter((setting) => !SECRET_SETTINGS.includes(setting.key) && !INSTALL_SETTINGS.includes(setting.key)),
      ...(apiKey ? { apiKey } : {}),
      ...(Object.keys(jobSourceKeys).length > 0 ? { jobSourceKeys } : {}),
      applications,
      postings,
      searches,
      agentCandidates,
      startups,
      startupBlocks,
    };
  });
}
