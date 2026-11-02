import "server-only";

import { env, type Env } from "@/lib/core/env";
import { decryptSecret, SecretUnreadable, TYPESAFE_KEY } from "@/lib/core/secrets";
import type { SettingsData } from "@/lib/settings/settings";
import { loadSettings } from "@/lib/settings/settings-data";

import { SCORING_KEY_MISSING, SCORING_KEY_UNREADABLE, type Scorer, type ScoringKeyState, type ScoringView } from "./scorers";

// What scores postings: the choice saved in Settings → Scoring, or
// else FITBOARD_SCORER, or else the AI model; and Jev's key, saved there or
// in FITBOARD_TYPESAFE_KEY.

export type ScoringConfig = {
  scorer: Scorer;
  /** Whether the choice is saved in Settings, rather than coming from FITBOARD_SCORER or the default. */
  saved: boolean;
  key: string | null;
  keyState: ScoringKeyState;
};

const FROM_ENV: Record<NonNullable<Env["FITBOARD_SCORER"]>, Scorer> = { ai: "AI", jev: "JEV" };

export function resolveScoringConfig(
  saved: Pick<SettingsData, "scorer" | "typesafeKeyEnc">,
  source: Pick<Env, "FITBOARD_SCORER" | "FITBOARD_TYPESAFE_KEY">,
  secret?: string,
): ScoringConfig {
  const scorer = saved.scorer ?? (source.FITBOARD_SCORER ? FROM_ENV[source.FITBOARD_SCORER] : "AI");
  const choice = { scorer, saved: saved.scorer !== null };
  if (saved.typesafeKeyEnc) {
    try {
      return { ...choice, key: decryptSecret(TYPESAFE_KEY, saved.typesafeKeyEnc, secret), keyState: "set" };
    } catch (error) {
      if (!(error instanceof SecretUnreadable)) throw error;
      return { ...choice, key: null, keyState: "unreadable" };
    }
  }
  return source.FITBOARD_TYPESAFE_KEY ? { ...choice, key: source.FITBOARD_TYPESAFE_KEY, keyState: "env" } : { ...choice, key: null, keyState: "none" };
}

/** The scoring configuration in effect right now. */
export async function loadScoringConfig(): Promise<ScoringConfig> {
  return resolveScoringConfig(await loadSettings(), env);
}

export const scoringView = (config: ScoringConfig): ScoringView => ({ scorer: config.scorer, keyState: config.keyState });

/** Jev's key, or why there isn't one, in words. */
export function jevKey({ key, keyState }: Pick<ScoringConfig, "key" | "keyState">): { key: string; problem: null } | { key: null; problem: string } {
  if (key) return { key, problem: null };
  return { key: null, problem: keyState === "unreadable" ? SCORING_KEY_UNREADABLE : SCORING_KEY_MISSING };
}
