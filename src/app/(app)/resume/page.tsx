import type { Metadata } from "next";

import { loadProfile } from "@/lib/profile/profile-data";
import { maxPages } from "@/lib/settings/settings";
import { loadSettings } from "@/lib/settings/settings-data";
import { loadThemes, loadThemeUsage } from "@/lib/documents/theme-data";

import { ResumeWorkspace } from "./resume-workspace";

export const metadata: Metadata = { title: "Base resume" };

/** The base resume: a live preview of the profile in the chosen theme. */
export default async function BaseResumePage() {
  const [profile, themes, settings, usage] = await Promise.all([loadProfile(), loadThemes(), loadSettings(), loadThemeUsage()]);
  return (
    <ResumeWorkspace
      profile={profile}
      themes={themes}
      usage={usage}
      baseThemeId={settings.baseThemeId}
      paper={settings.paper}
      includeReferences={settings.includeRefs}
      language={settings.resumeLanguage}
      maxPages={maxPages(settings.pageLimit)}
    />
  );
}
