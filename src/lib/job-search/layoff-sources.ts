import "server-only";

import catalog from "../../../config/layoff-sources.json";

export type LayoffSourceKind = "airtable" | "csv" | "warn-latest" | "layoffmap-html";

export type LayoffSourceConfig = {
  id: string;
  label: string;
  kind: LayoffSourceKind;
  enabled: boolean;
  attributionUrl: string;
  /** Airtable shared-view embed (kind=airtable). */
  embedUrl?: string;
  /** Airtable application id header (kind=airtable). */
  appId?: string;
  /** When set, this source only runs if that id failed (kind=csv). */
  fallbackFor?: string;
  /** Ordered fetch URLs (csv / warn-latest). */
  urls?: string[];
  /** Single page URL (layoffmap-html). */
  url?: string;
};

type Catalog = { sources: LayoffSourceConfig[] };

const parsed = catalog as Catalog;

/** Every source entry from config/layoff-sources.json (enabled or not). */
export function allLayoffSources(): LayoffSourceConfig[] {
  return Array.isArray(parsed.sources) ? parsed.sources : [];
}

/** Enabled sources in catalog order. */
export function enabledLayoffSources(): LayoffSourceConfig[] {
  return allLayoffSources().filter((source) => source.enabled);
}

export function layoffSourceById(id: string): LayoffSourceConfig | undefined {
  return allLayoffSources().find((source) => source.id === id);
}

/** Human label for a stored event source URL, from the catalog when possible. */
export function labelForLayoffSourceUrl(sourceUrl: string): string {
  const url = sourceUrl.trim();
  if (!url) return "Unknown source";
  for (const source of allLayoffSources()) {
    if (url === source.attributionUrl || url === source.url) return source.label;
    if (source.embedUrl && url.startsWith(source.embedUrl)) return source.label;
    if (source.urls?.some((entry) => entry === url || url.startsWith(entry))) return source.label;
    try {
      const host = new URL(url).hostname.replace(/^www\./, "");
      const attrHost = new URL(source.attributionUrl).hostname.replace(/^www\./, "");
      if (host === attrHost) return source.label;
    } catch {
      // keep scanning
    }
  }
  // Legacy Layoffs.fyi rows stored the news article URL, not the tracker URL.
  const layoffsFyi = layoffSourceById("layoffs.fyi");
  if (layoffsFyi && /^https?:\/\//i.test(url)) return layoffsFyi.label;
  return "Unknown source";
}

/** Attribution line built from the sources that actually contributed. */
export function attributionForSources(sourceIds: string[]): { attribution: string; attributionUrl: string } {
  const matched = sourceIds
    .map((id) => layoffSourceById(id))
    .filter((source): source is LayoffSourceConfig => Boolean(source));
  const list = matched.length > 0 ? matched : enabledLayoffSources();
  const labels = [...new Set(list.map((source) => source.label))];
  const attribution = labels.length > 0 ? `Data from ${labels.join(", ")}` : "Layoff data";
  const attributionUrl = list[0]?.attributionUrl || "https://layoffs.fyi/";
  return { attribution, attributionUrl };
}
