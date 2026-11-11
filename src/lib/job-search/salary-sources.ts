import "server-only";

import catalog from "../../../config/salary-sources.json";

export type SalarySourceKind = "adzuna" | "paycrunch" | "ambitionbox" | "glassdoor";

export type SalarySourceConfig = {
  id: string;
  label: string;
  kind: SalarySourceKind;
  enabled: boolean;
  attributionUrl: string;
  /** Adzuna API root (kind=adzuna). */
  baseUrl?: string;
  /** Countries this source covers (ISO 3166-1 alpha-2, lower case). Empty/omitted = all. */
  countries?: string[];
  /** Per-country currency map (kind=adzuna). */
  currencies?: Record<string, string>;
  /** Default currency when the source is single-currency. */
  currency?: string;
  jobsIndexUrl?: string;
  jobUrlTemplate?: string;
  /** AmbitionBox designation page, with `{slug}`. */
  profileUrlTemplate?: string;
  /** Glassdoor HTML salary page, with `{slug}` and `{length}`. */
  pageUrlTemplate?: string;
  /** Optional third-party Glassdoor JSON API, with `{title}` and `{place}`. */
  apiUrlTemplate?: string;
  /** Env var name holding the API key for apiUrlTemplate (e.g. FITBOARD_GLASSDOOR_API_KEY). */
  apiKeyEnv?: string;
};

type Catalog = { sources: SalarySourceConfig[] };

const parsed = catalog as Catalog;

export function allSalarySources(): SalarySourceConfig[] {
  return Array.isArray(parsed.sources) ? parsed.sources : [];
}

export function enabledSalarySources(): SalarySourceConfig[] {
  return allSalarySources().filter((source) => source.enabled);
}

export function salarySourceById(id: string): SalarySourceConfig | undefined {
  return allSalarySources().find((source) => source.id === id);
}

/** Currency hint for parsing offer text — from the first catalog source that covers the country. */
export function currencyForCountry(country: string): string {
  const code = country.trim().toLowerCase();
  if (!code) return "";
  for (const source of enabledSalarySources()) {
    if (source.currencies?.[code]) return source.currencies[code];
    if (source.countries?.includes(code) && source.currency) return source.currency;
  }
  return "";
}

export function sourceCoversCountry(source: SalarySourceConfig, country: string): boolean {
  const code = country.trim().toLowerCase();
  if (!code) return false;
  if (!source.countries?.length) return true;
  return source.countries.includes(code);
}
