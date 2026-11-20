import "server-only";

import { countryCodeFor } from "@/lib/job-search/countries";
import { appVersion } from "@/lib/upkeep/version";

import { loadPlaceCatalog, saveLearnedPlaces } from "./place-catalog";
import { continentForCountry, humanizeCity, normalizeEventPlace, type CatalogCity } from "./place";
import type { FoundEvent } from "./types";

// After a source fetch: resolve places against the catalog, geocode unknowns
// once via OpenStreetMap Nominatim, and remember them in EventPlace.

const USER_AGENT = `Fitboard/${appVersion} (event places; +https://github.com/thisiskushal31/fitboard)`;

type GeoResult = { name: string; country: string; continent: string };

async function geocodeCity(query: string, signal?: AbortSignal): Promise<GeoResult | null> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length < 2) return null;
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("q", trimmed);
  url.searchParams.set("format", "json");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "1");
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      signal: signal ?? AbortSignal.timeout(8_000),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const rows = (await response.json()) as {
      name?: string;
      address?: { city?: string; town?: string; village?: string; municipality?: string; country_code?: string };
    }[];
    const hit = rows[0];
    if (!hit) return null;
    const country = (hit.address?.country_code ?? "").toLowerCase();
    if (!/^[a-z]{2}$/.test(country)) return null;
    const name =
      hit.address?.city ||
      hit.address?.town ||
      hit.address?.village ||
      hit.address?.municipality ||
      humanizeCity(trimmed) ||
      trimmed;
    return { name: name.slice(0, 120), country, continent: continentForCountry(country) };
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Rebuild each event's place line from the full catalog (seed + learned),
 * geocode cities that are still unknown (at most once per distinct name),
 * and save those cities for the next refresh — no code change required.
 */
export async function enrichEventPlaces(events: readonly FoundEvent[], signal?: AbortSignal): Promise<FoundEvent[]> {
  const places = await loadPlaceCatalog();
  const learned: CatalogCity[] = [];
  const geocodeCache = new Map<string, GeoResult | null>();
  // Cap live lookups per refresh so company + aggregator feeds cannot stall the job.
  const MAX_GEOCODE = events.length > 200 ? 5 : 15;
  let geocodeCount = 0;

  const out: FoundEvent[] = [];
  for (const event of events) {
    signal?.throwIfAborted();
    let parts = normalizeEventPlace(
      {
        location: event.place,
        city: event.city,
        country: event.country,
        online: event.format === "VIRTUAL" && (!event.place || /^(?:remote|online|virtual)$/i.test(event.place)),
      },
      places,
    );

    const cityKey = (parts.city || event.city).trim();
    if (cityKey && !parts.country && !places.lookup(cityKey)) {
      const cacheKey = cityKey.toLowerCase();
      let geo = geocodeCache.get(cacheKey);
      if (geo === undefined && geocodeCount < MAX_GEOCODE) {
        geocodeCount += 1;
        // Nominatim asks for ≤1 request/second.
        await sleep(1100);
        geo = await geocodeCity(cityKey, signal);
        geocodeCache.set(cacheKey, geo);
      }
      if (geo) {
        const entry: CatalogCity = { name: geo.name, country: geo.country, continent: geo.continent };
        places.remember?.(entry);
        learned.push(entry);
        parts = normalizeEventPlace({ location: event.place, city: geo.name, country: geo.country }, places);
      }
    } else if (cityKey && parts.country && !places.lookup(cityKey)) {
      const entry: CatalogCity = {
        name: humanizeCity(cityKey) || cityKey,
        country: parts.country,
        continent: continentForCountry(parts.country),
      };
      // Only learn when the country looks real.
      if (countryCodeFor(parts.country) || /^[a-z]{2}$/.test(parts.country)) {
        places.remember?.(entry);
        learned.push(entry);
        parts = normalizeEventPlace({ location: event.place, city: entry.name, country: entry.country }, places);
      }
    }

    out.push({ ...event, place: parts.place, city: parts.city, country: parts.country });
  }

  if (learned.length > 0) await saveLearnedPlaces(learned);
  return out;
}
