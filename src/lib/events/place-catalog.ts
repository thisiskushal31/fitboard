import "server-only";

import catalog from "../../../config/event-places.json";

import { prisma } from "@/lib/core/prisma";

import { continentForCountry, foldPlaceKey, seedPlaceCatalog, type CatalogCity, type PlaceCatalog } from "./place";

// Learned EventPlace rows merged with config/event-places.json for refresh.

type SeedFile = { cities: { name: string; country: string; aliases?: string[] }[] };
const seedKeys = new Set(
  (catalog as SeedFile).cities.flatMap((city) => [foldPlaceKey(city.name), ...(city.aliases ?? []).map(foldPlaceKey)].filter(Boolean)),
);

/** Seed plus learned EventPlace rows from the database. */
export async function loadPlaceCatalog(): Promise<PlaceCatalog> {
  const base = seedPlaceCatalog();
  const learned = await prisma.eventPlace.findMany();
  const extra = new Map<string, CatalogCity>();
  for (const row of learned) {
    const entry: CatalogCity = {
      name: row.name,
      country: row.country.toLowerCase(),
      continent: row.continent || continentForCountry(row.country),
    };
    extra.set(row.key, entry);
    extra.set(foldPlaceKey(row.name), entry);
  }
  return {
    lookup(city) {
      const key = foldPlaceKey(city);
      return extra.get(key) ?? base.lookup(city);
    },
    remember(city) {
      const key = foldPlaceKey(city.name);
      if (!key) return;
      const entry = { ...city, continent: city.continent || continentForCountry(city.country) };
      extra.set(key, entry);
      extra.set(foldPlaceKey(city.name), entry);
    },
  };
}

/** Persist newly learned cities so the next refresh does not need to look them up again. */
export async function saveLearnedPlaces(cities: CatalogCity[]): Promise<void> {
  const seen = new Set<string>();
  for (const city of cities) {
    const key = foldPlaceKey(city.name);
    if (!key || seen.has(key) || seedKeys.has(key)) continue;
    seen.add(key);
    const continent = city.continent || continentForCountry(city.country);
    await prisma.eventPlace.upsert({
      where: { key },
      create: { key, name: city.name.slice(0, 120), country: city.country.slice(0, 8), continent: continent.slice(0, 40) },
      update: { name: city.name.slice(0, 120), country: city.country.slice(0, 8), continent: continent.slice(0, 40) },
    });
  }
}
