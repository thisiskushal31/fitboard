import "server-only";

import { maxPages } from "@/lib/settings/settings";
import { loadSettings } from "@/lib/settings/settings-data";

import type { TaskOptions } from "./tasks";

/** The AI behaviour saved in Settings, for running a task. */
export async function loadTaskOptions(): Promise<Omit<TaskOptions, "signal">> {
  const { creativity, strict, docLanguage, pageLimit } = await loadSettings();
  // Null follows the posting's language.
  return { creativity, strict, language: docLanguage, maxPages: maxPages(pageLimit) };
}
