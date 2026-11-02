import "server-only";

import { hkdfSync } from "node:crypto";

import { env } from "@/lib/core/env";

/**
 * What a key derived from FITBOARD_SECRET is for. Each purpose gets its own key
 * (a different HKDF `info`), so a key can't be reused for something else.
 */
export type KeyPurpose = "session" | "password-fingerprint" | "api-key-encryption" | "job-source-key-encryption" | "typesafe-key-encryption" | "print-token" | "google-token-encryption" | "google-client-secret-encryption" | "oauth-state" | "connector-client" | "connector-code" | "connector-access" | "connector-refresh";

const cached = new Map<KeyPurpose, Uint8Array>();

/** A 256-bit key for `purpose`, derived from `secret` (FITBOARD_SECRET by default) with HKDF-SHA256. */
export function deriveKey(purpose: KeyPurpose, secret?: string): Uint8Array {
  if (secret !== undefined) return hkdf(secret, purpose);
  let key = cached.get(purpose);
  if (!key) {
    key = hkdf(env.FITBOARD_SECRET, purpose);
    cached.set(purpose, key);
  }
  return key;
}

function hkdf(secret: string, purpose: KeyPurpose): Uint8Array {
  return new Uint8Array(hkdfSync("sha256", secret, "", `fitboard ${purpose} v1`, 32));
}
