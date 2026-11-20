import catalog from "../../../config/event-places.json";

import { countryCodeFor, countryName } from "@/lib/job-search/countries";

// Event place lines: city + continent from config/event-places.json (and, on
// refresh, cities learned into the database — see place-learn.ts).

type SeedFile = {
  continents: Record<string, string>;
  subdivisions: Record<string, string[]>;
  cities: { name: string; country: string; aliases?: string[] }[];
};

const seed = catalog as SeedFile;

const ONLINE = /^(?:remote|online|virtual)$/i;

const CONTINENT_NAMES = new Map(
  [
    ["north america", "North America"],
    ["europe", "Europe"],
    ["africa", "Africa"],
    ["asia", "Asia"],
    ["oceania", "Oceania"],
    ["australia", "Oceania"],
    ["middle east", "Middle East"],
    ["latin america", "Latin America"],
    ["south america", "Latin America"],
    ["central america", "Latin America"],
  ].map(([key, name]) => [key, name] as const),
);

export type CatalogCity = { name: string; country: string; continent: string };

/** Fold a city name for lookup. */
export function foldPlaceKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function continentOf(country: string): string {
  return seed.continents[country.toLowerCase()] ?? "";
}

function buildSeedIndex(): Map<string, CatalogCity> {
  const index = new Map<string, CatalogCity>();
  for (const city of seed.cities) {
    const country = city.country.toLowerCase();
    const entry: CatalogCity = { name: city.name, country, continent: continentOf(country) };
    index.set(foldPlaceKey(city.name), entry);
    for (const alias of city.aliases ?? []) {
      const key = foldPlaceKey(alias);
      if (key && !index.has(key)) index.set(key, entry);
    }
  }
  return index;
}

const seedIndex = buildSeedIndex();

const subdivisionCountry = new Map<string, string>();
for (const [country, codes] of Object.entries(seed.subdivisions)) {
  for (const code of codes) subdivisionCountry.set(code.toUpperCase(), country.toLowerCase());
}

export type PlaceCatalog = {
  lookup(city: string): CatalogCity | undefined;
  remember?(city: CatalogCity): void;
};

/** In-memory catalog from the seed file only. */
export function seedPlaceCatalog(): PlaceCatalog {
  return {
    lookup(city) {
      return seedIndex.get(foldPlaceKey(city));
    },
  };
}

/** Continent label for an ISO country from config/event-places.json. */
export function continentForCountry(code: string): string {
  return continentOf(code.trim().toLowerCase());
}

/** "san-francisco" / "bangalore" → "San Francisco" / "Bangalore"; proper names stay put. */
export function humanizeCity(value: string): string {
  const raw = value.trim();
  if (!raw || ONLINE.test(raw)) return "";
  const known = seedIndex.get(foldPlaceKey(raw));
  if (known) return known.name;
  if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw)) {
    return raw
      .split("-")
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  }
  return raw;
}

function regionLabel(country: string): string {
  return continentForCountry(country) || (country ? countryName(country) : "");
}

function countryFromLocationTail(cityHint: string, last: string, places: PlaceCatalog): string {
  if (!last || ONLINE.test(last)) return "";
  const upper = last.toUpperCase();
  const fromSubdivision = subdivisionCountry.get(upper);
  if (fromSubdivision) {
    // CA is California only when the city is already known as US in the catalog.
    if (upper === "CA") {
      const known = places.lookup(cityHint);
      if (known?.country === "us") return "us";
      if (known?.country === "ca") return "ca";
      // Unknown city + CA: prefer catalog/geocode later; treat as US state only when city looks Californian via seed miss → try US if city empty of country knowledge
      if (known) return known.country;
    }
    if (upper === "WA") {
      const known = places.lookup(cityHint);
      if (known?.country === "au") return "au";
    }
    return fromSubdivision;
  }
  if (CONTINENT_NAMES.has(last.toLowerCase())) return "";
  return countryCodeFor(last) || "";
}

/** ISO country from an explicit field and/or a free-text location. */
export function countryFromEventLocation(explicit: string, location: string, places: PlaceCatalog = seedPlaceCatalog()): string {
  const fromExplicit = countryCodeFor(explicit.trim());
  if (fromExplicit) return fromExplicit;

  const parts = location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  const cityHint = parts.length >= 2 ? parts[0]! : "";
  const knownCity = places.lookup(cityHint);
  if (knownCity) return knownCity.country;
  return countryFromLocationTail(cityHint, parts[parts.length - 1]!, places);
}

function continentFromLocation(location: string): string {
  const parts = location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) return "";
  return CONTINENT_NAMES.get(parts[parts.length - 1]!.toLowerCase()) ?? "";
}

export type EventPlaceParts = { place: string; city: string; country: string };

/**
 * City + continent for storage and the card. Uses the place catalog (seed, and
 * on refresh the learned DB rows via enrichEventPlaces).
 */
export function normalizeEventPlace(
  input: {
    location?: string;
    city?: string;
    country?: string;
    online?: boolean;
  },
  places: PlaceCatalog = seedPlaceCatalog(),
): EventPlaceParts {
  const location = (input.location ?? "").trim();
  if (input.online || ONLINE.test(location)) {
    return { place: "Online", city: "", country: "" };
  }

  let city = humanizeCity(input.city ?? "");
  const parts = location
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!city && parts[0] && !ONLINE.test(parts[0]) && !CONTINENT_NAMES.has(parts[0].toLowerCase())) {
    city = humanizeCity(parts[0]);
  }
  if (ONLINE.test(city)) return { place: "Online", city: "", country: "" };

  const known = city ? places.lookup(city) : undefined;
  let country = known?.country || countryFromEventLocation(input.country ?? "", location, places);
  if (!country && known) country = known.country;

  const broader = known?.continent || regionLabel(country) || continentFromLocation(location);
  const displayCity = known?.name || city;
  const place =
    displayCity && broader && displayCity.toLowerCase() !== broader.toLowerCase()
      ? `${displayCity}, ${broader}`
      : displayCity || broader || location;

  return {
    place: place.slice(0, 300),
    city: displayCity.slice(0, 120),
    country: country.slice(0, 8),
  };
}

/** What the Events card shows under the title: never blank when city or place exists. */
export function eventLocationLabel(event: {
  place: string;
  city: string;
  country: string;
  format?: string;
  remote?: boolean | null;
}): string {
  const place = event.place.trim();
  if (place) return place;
  const city = humanizeCity(event.city);
  const broader = regionLabel(event.country);
  const built = [city, broader].filter(Boolean).join(", ");
  if (built) return built;
  if (event.format === "VIRTUAL" || event.remote) return "Online";
  return "";
}
