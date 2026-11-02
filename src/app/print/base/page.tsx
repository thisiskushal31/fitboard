import type { Metadata } from "next";

import { ResumeDocument } from "@/components/documents/resume-document";
import { verifyPrintAccess } from "@/lib/pdf/print-access";
import { loadProfile } from "@/lib/profile/profile-data";
import { loadSettings } from "@/lib/settings/settings-data";
import { loadTheme } from "@/lib/documents/theme-data";
import { BUILT_IN_THEMES, printCss } from "@/lib/documents/themes";

export const metadata: Metadata = { title: "Base resume", robots: { index: false } };

/** The base resume on its own, for the PDF renderer to print. */
export default async function PrintBaseResumePage() {
  await verifyPrintAccess("/print/base");
  const [profile, settings] = await Promise.all([loadProfile(), loadSettings()]);
  const theme = (await loadTheme(settings.baseThemeId)) ?? BUILT_IN_THEMES[0];

  return (
    <>
      <style>{printCss(theme, settings.paper)}</style>
      <ResumeDocument theme={theme} profile={profile} paper={settings.paper} includeReferences={settings.includeRefs} language={settings.resumeLanguage} />
    </>
  );
}
