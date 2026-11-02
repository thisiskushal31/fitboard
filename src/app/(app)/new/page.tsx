import type { Metadata } from "next";

import { isAiConfigured, isAiUsable } from "@/lib/ai/config";
import { handsOffToClaude } from "@/lib/connector/handoff";
import { DEMO_POSTING } from "@/lib/profile/demo-profile";
import { postingText } from "@/lib/job-search/search";
import { prisma } from "@/lib/core/prisma";
import { loadSettings } from "@/lib/settings/settings-data";
import { getStartup, startupPostingText } from "@/lib/startups/store";

import { NewApplication } from "./new-application";

export const metadata: Metadata = { title: "New application" };

/** From the posting, through the match, to the tailored documents. Nothing is stored until the last step. */
export default async function NewApplicationPage({ searchParams }: PageProps<"/new">) {
  const { fresh, posting, startup: startupId } = await searchParams;
  const [aiReady, writeInClaude, applications, settings, fromFindJobs, startup] = await Promise.all([
    isAiConfigured(),
    isAiUsable().then(handsOffToClaude),
    prisma.application.count({ where: { awaitingReview: false } }),
    loadSettings(),
    // "Start application" on Find jobs.
    typeof posting === "string" ? prisma.posting.findUnique({ where: { id: posting } }) : null,
    // "Write to them" on Startups: what's known about the startup, without its addresses.
    typeof startupId === "string" ? getStartup(startupId) : null,
  ]);
  return (
    <NewApplication
      aiReady={aiReady}
      writeInClaude={writeInClaude}
      defaultTone={settings.defaultTone}
      fresh={fresh !== undefined}
      fromPosting={
        fromFindJobs
          ? { id: fromFindJobs.id, text: postingText(fromFindJobs), url: fromFindJobs.url, complete: fromFindJobs.complete }
          : startup && {
              id: null,
              startup: { id: startup.id, company: startup.company },
              text: startupPostingText(startup),
              url: startup.links[0]?.url ?? startup.website,
              complete: true,
            }
      }
      // A first-run helper: only until the first application exists.
      samplePosting={applications === 0 ? DEMO_POSTING : null}
    />
  );
}
