import { describe, expect, it } from "vitest";

import {
  continentForCountry,
  countryFromEventLocation,
  eventLocationLabel,
  foldPlaceKey,
  humanizeCity,
  normalizeEventPlace,
  seedPlaceCatalog,
  type PlaceCatalog,
} from "@/lib/events/place";

describe("event place", () => {
  it("humanises city slugs using the places catalog", () => {
    expect(humanizeCity("san-francisco")).toBe("San Francisco");
    expect(humanizeCity("bangalore")).toBe("Bengaluru");
    expect(humanizeCity("Las Vegas")).toBe("Las Vegas");
    expect(humanizeCity("remote")).toBe("");
  });

  it("maps countries to continents from config/event-places.json", () => {
    expect(continentForCountry("us")).toBe("North America");
    expect(continentForCountry("de")).toBe("Europe");
    expect(continentForCountry("ng")).toBe("Africa");
    expect(continentForCountry("in")).toBe("Asia");
    expect(continentForCountry("br")).toBe("Latin America");
    expect(continentForCountry("au")).toBe("Oceania");
    expect(continentForCountry("ae")).toBe("Middle East");
  });

  it("builds city and continent from scraped location fields via the catalog", () => {
    expect(normalizeEventPlace({ location: "Las Vegas, NV", city: "" })).toEqual({
      place: "Las Vegas, North America",
      city: "Las Vegas",
      country: "us",
    });
    expect(normalizeEventPlace({ location: "San Francisco, CA", city: "san-francisco" })).toEqual({
      place: "San Francisco, North America",
      city: "San Francisco",
      country: "us",
    });
    expect(normalizeEventPlace({ city: "Berlin", country: "DE" })).toEqual({
      place: "Berlin, Europe",
      city: "Berlin",
      country: "de",
    });
    expect(normalizeEventPlace({ location: "Berlin, Germany" })).toEqual({
      place: "Berlin, Europe",
      city: "Berlin",
      country: "de",
    });
    expect(normalizeEventPlace({ location: "Lagos, Nigeria" })).toEqual({
      place: "Lagos, Africa",
      city: "Lagos",
      country: "ng",
    });
    expect(normalizeEventPlace({ location: "Bangalore", city: "bangalore" })).toEqual({
      place: "Bengaluru, Asia",
      city: "Bengaluru",
      country: "in",
    });
    expect(normalizeEventPlace({ city: "Bengaluru", country: "India" })).toEqual({
      place: "Bengaluru, Asia",
      city: "Bengaluru",
      country: "in",
    });
    expect(normalizeEventPlace({ location: "Toronto, ON" })).toEqual({
      place: "Toronto, North America",
      city: "Toronto",
      country: "ca",
    });
    expect(normalizeEventPlace({ location: "Sydney, NSW" })).toEqual({
      place: "Sydney, Oceania",
      city: "Sydney",
      country: "au",
    });
    expect(normalizeEventPlace({ location: "Remote", online: true })).toEqual({
      place: "Online",
      city: "",
      country: "",
    });
  });

  it("falls back to city and continent on the card when place was left empty", () => {
    expect(eventLocationLabel({ place: "", city: "las-vegas", country: "us" })).toBe("Las Vegas, North America");
    expect(eventLocationLabel({ place: "Las Vegas, North America", city: "Las Vegas", country: "us" })).toBe("Las Vegas, North America");
    expect(eventLocationLabel({ place: "", city: "", country: "", format: "VIRTUAL", remote: true })).toBe("Online");
    expect(eventLocationLabel({ place: "", city: "", country: "" })).toBe("");
  });

  it("resolves ambiguous subdivisions and continent-only locations", () => {
    expect(normalizeEventPlace({ location: "Perth, WA" })).toMatchObject({ city: "Perth", country: "au" });
    expect(normalizeEventPlace({ location: "Seattle, WA" })).toMatchObject({ country: "us" });
    expect(normalizeEventPlace({ location: "San Jose, CA" })).toMatchObject({ country: "us" });
    expect(normalizeEventPlace({ location: "Unknownville, CA" })).toMatchObject({ country: "us" });
    expect(normalizeEventPlace({ location: "Europe" })).toMatchObject({ place: "Europe", city: "", country: "" });
    expect(normalizeEventPlace({ location: "Berlin, Europe" })).toMatchObject({ city: "Berlin", place: "Berlin, Europe" });
    expect(normalizeEventPlace({ location: "Remote" })).toEqual({ place: "Online", city: "", country: "" });
    expect(normalizeEventPlace({ online: true, city: "Berlin" })).toEqual({ place: "Online", city: "", country: "" });
    expect(normalizeEventPlace({ location: "Austin, TX" })).toMatchObject({ country: "us" });
    expect(normalizeEventPlace({ country: "Germany", city: "Hamburg" })).toMatchObject({ country: "de" });
    expect(humanizeCity("some-new-burg")).toBe("Some New Burg");
    expect(humanizeCity("online")).toBe("");
    expect(humanizeCity("")).toBe("");
    expect(continentForCountry("")).toBe("");
    expect(foldPlaceKey("São  Paulo")).toBe("sao paulo");
    expect(countryFromEventLocation("United States", "")).toBe("us");
    expect(countryFromEventLocation("", "Online")).toBe("");
    expect(countryFromEventLocation("", "")).toBe("");
  });

  it("uses an injected place catalog for lookups", () => {
    const places: PlaceCatalog = {
      lookup: (city) =>
        foldPlaceKey(city) === "xanadu" ? { name: "Xanadu", country: "zz", continent: "Asia" } : undefined,
    };
    expect(normalizeEventPlace({ city: "Xanadu" }, places)).toEqual({
      place: "Xanadu, Asia",
      city: "Xanadu",
      country: "zz",
    });
    expect(seedPlaceCatalog().lookup("Berlin")?.country).toBe("de");
  });
});
