import path from "node:path";

import { describe, expect, it } from "vitest";

import { EnvError, parseEnv } from "@/lib/core/env";

// A hash of "correct horse" (scripts/hash-password.ts).
const PASSWORD_HASH = "argon2id:m=19456,t=2,p=1:CLZW5wQoCjh3Q9CHBp_JWw:Ak2xS7TYlYYrhemlgBkVxFmWXfcMq_rjd0mJGZcZFfA";

const valid = {
  FITBOARD_PASSWORD: PASSWORD_HASH,
  FITBOARD_SECRET: "a".repeat(32),
  DATABASE_URL: "postgresql://postgres:postgres@db:5432/fitboard",
};

function problems(source: Record<string, string | undefined>): string[] {
  try {
    parseEnv(source);
  } catch (error) {
    if (error instanceof EnvError) return error.problems;
    throw error;
  }
  throw new Error("Expected parseEnv to throw");
}

describe("parseEnv", () => {
  it("accepts the required variables and fills in defaults", () => {
    expect(parseEnv(valid)).toEqual({
      ...valid,
      FITBOARD_DATA_DIR: "/data",
      FITBOARD_BACKUP_RETENTION_DAYS: 14,
      FITBOARD_TELEMETRY: undefined,
    });
  });

  it("reads whether the usage ping is on", () => {
    // Unset or empty: Fitboard asks.
    expect(parseEnv({ ...valid, FITBOARD_TELEMETRY: "" }).FITBOARD_TELEMETRY).toBeUndefined();
    expect(parseEnv(valid).FITBOARD_TELEMETRY).toBeUndefined();
    expect(parseEnv({ ...valid, FITBOARD_TELEMETRY: "ON" }).FITBOARD_TELEMETRY).toBe("on");
    expect(parseEnv({ ...valid, FITBOARD_TELEMETRY: " Off " }).FITBOARD_TELEMETRY).toBe("off");
    expect(problems({ ...valid, FITBOARD_TELEMETRY: "false" })).toEqual(['FITBOARD_TELEMETRY must be on or off (got "false").']);
  });

  it("reads the optional variables", () => {
    const env = parseEnv({
      ...valid,
      FITBOARD_DATA_DIR: "/srv/fitboard",
      FITBOARD_BACKUP_RETENTION_DAYS: "30",
      FITBOARD_AI_PROVIDER: "local",
      FITBOARD_AI_URL: "http://ollama:11434",
      FITBOARD_AI_MODEL: "llama3.1:8b",
      FITBOARD_AI_KEY: "sk-test",
    });
    expect(env).toMatchObject({
      FITBOARD_DATA_DIR: "/srv/fitboard",
      FITBOARD_BACKUP_RETENTION_DAYS: 30,
      FITBOARD_AI_PROVIDER: "local",
      FITBOARD_AI_URL: "http://ollama:11434",
      FITBOARD_AI_MODEL: "llama3.1:8b",
      FITBOARD_AI_KEY: "sk-test",
    });
  });

  it("reads the AI timeout in seconds", () => {
    expect(parseEnv({ ...valid, FITBOARD_AI_TIMEOUT_SECONDS: " 300 " }).FITBOARD_AI_TIMEOUT_SECONDS).toBe(300);
    expect(() => parseEnv({ ...valid, FITBOARD_AI_TIMEOUT_SECONDS: "5m" })).toThrow(/whole number of seconds/);
    expect(() => parseEnv({ ...valid, FITBOARD_AI_TIMEOUT_SECONDS: "1" })).toThrow(/at least 5/);
  });

  it("resolves a relative data directory", () => {
    const env = parseEnv({ ...valid, FITBOARD_DATA_DIR: "../data" });
    expect(env.FITBOARD_DATA_DIR).toBe(path.resolve("../data"));
  });

  it("treats empty values as unset", () => {
    const env = parseEnv({ ...valid, FITBOARD_AI_KEY: "", FITBOARD_DATA_DIR: " " });
    expect(env.FITBOARD_AI_KEY).toBeUndefined();
    expect(env.FITBOARD_DATA_DIR).toBe("/data");
    expect(problems({ ...valid, FITBOARD_PASSWORD: "" })).toEqual([
      expect.stringMatching(/^FITBOARD_PASSWORD is not set\./),
    ]);
  });

  it("names every missing required variable", () => {
    expect(problems({})).toEqual([
      expect.stringMatching(/^FITBOARD_PASSWORD is not set\. Set it to/),
      expect.stringMatching(/^FITBOARD_SECRET is not set\. .*openssl rand/),
      expect.stringMatching(/^DATABASE_URL is not set\. /),
    ]);
  });

  it("wants a hash of the password, not the password itself", () => {
    expect(problems({ ...valid, FITBOARD_PASSWORD: "correct horse" })).toEqual([
      expect.stringMatching(/^FITBOARD_PASSWORD must be a hash of your password, not the password itself\. .*hash-password/),
    ]);
    expect(parseEnv({ ...valid, FITBOARD_PASSWORD: ` ${PASSWORD_HASH}\n` }).FITBOARD_PASSWORD).toBe(PASSWORD_HASH);
  });

  it("rejects a secret shorter than 32 characters", () => {
    expect(problems({ ...valid, FITBOARD_SECRET: "short" })).toEqual([
      expect.stringMatching(/^FITBOARD_SECRET is too short \(5 characters\)\./),
    ]);
  });

  it("never echoes secret values", () => {
    const messages = problems({
      FITBOARD_PASSWORD: "hunter2",
      FITBOARD_SECRET: "tiny-secret",
      DATABASE_URL: "mysql://root:db-password@db/fitboard",
    }).join("\n");
    expect(messages).not.toContain("hunter2");
    expect(messages).not.toContain("tiny-secret");
    expect(messages).not.toContain("db-password");
    expect(messages).toMatch(/DATABASE_URL must be a PostgreSQL connection string/);
  });

  it("rejects invalid optional values", () => {
    expect(
      problems({
        ...valid,
        FITBOARD_BACKUP_RETENTION_DAYS: "two weeks",
        FITBOARD_AI_PROVIDER: "gemini",
        FITBOARD_AI_URL: "ftp://example.com",
      }),
    ).toEqual([
      'FITBOARD_BACKUP_RETENTION_DAYS must be a whole number of days (got "two weeks").',
      'FITBOARD_AI_PROVIDER must be one of local, openai, anthropic, mistral, lmstudio, cursor (got "gemini").',
      "FITBOARD_AI_URL must be an http:// or https:// URL.",
    ]);
    expect(problems({ ...valid, FITBOARD_BACKUP_RETENTION_DAYS: "0" })).toEqual([
      "FITBOARD_BACKUP_RETENTION_DAYS must be at least 1.",
    ]);
  });
});

describe("job search variables", () => {
  it("reads the source and its keys", () => {
    expect(
      parseEnv({
        ...valid,
        FITBOARD_JOBS_SOURCE: "jsearch",
        FITBOARD_JSEARCH_KEY: "ak_test",
        FITBOARD_JSEARCH_HOST: "rapidapi",
        FITBOARD_ADZUNA_APP_ID: "app",
        FITBOARD_ADZUNA_KEY: "adz",
        FITBOARD_FREEHIRE_URL: "https://jobs.example/",
      }),
    ).toMatchObject({
      FITBOARD_JOBS_SOURCE: "jsearch",
      FITBOARD_JSEARCH_KEY: "ak_test",
      FITBOARD_JSEARCH_HOST: "rapidapi",
      FITBOARD_ADZUNA_APP_ID: "app",
      FITBOARD_ADZUNA_KEY: "adz",
      FITBOARD_FREEHIRE_URL: "https://jobs.example",
    });
    expect(parseEnv({ ...valid, FITBOARD_JOBS_SOURCE: "freehire" }).FITBOARD_JOBS_SOURCE).toBe("freehire");
  });

  it("reads whether the Bundesagentur für Arbeit is offered, and refuses choosing it while it's off", () => {
    expect(parseEnv(valid).FITBOARD_JOBS_ARBEITSAGENTUR).toBeUndefined();
    expect(parseEnv({ ...valid, FITBOARD_JOBS_ARBEITSAGENTUR: " OFF " }).FITBOARD_JOBS_ARBEITSAGENTUR).toBe("off");
    expect(problems({ ...valid, FITBOARD_JOBS_ARBEITSAGENTUR: "no" })).toEqual(['FITBOARD_JOBS_ARBEITSAGENTUR must be on or off (got "no").']);
    expect(problems({ ...valid, FITBOARD_JOBS_SOURCE: "arbeitsagentur", FITBOARD_JOBS_ARBEITSAGENTUR: "off" })).toEqual([
      "FITBOARD_JOBS_SOURCE is arbeitsagentur, but FITBOARD_JOBS_ARBEITSAGENTUR is off. Choose another source, or remove one of the two.",
    ]);
  });

  it("rejects sources and hosts it doesn't know, without echoing keys", () => {
    expect(problems({ ...valid, FITBOARD_JOBS_SOURCE: "linkedin", FITBOARD_JSEARCH_HOST: "google", FITBOARD_JSEARCH_KEY: "ak_secret" })).toEqual([
      'FITBOARD_JOBS_SOURCE must be one of jsearch, adzuna, arbeitsagentur, freehire, off (got "linkedin").',
      'FITBOARD_JSEARCH_HOST must be openwebninja or rapidapi (got "google").',
    ]);
  });
});
