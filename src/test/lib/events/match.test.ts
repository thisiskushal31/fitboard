import { describe, expect, it } from "vitest";

import { eventProximity, matchEvent, PROXIMITY_CITY, PROXIMITY_COUNTRY, PROXIMITY_FAR, PROXIMITY_VIRTUAL } from "@/lib/events/match";
import type { FoundEvent } from "@/lib/events/types";
import type { ProfileData } from "@/lib/profile/profile";
import { placeOf } from "@/lib/startups/place";

const berlin = placeOf({ city: "Berlin", country: "Germany" });
const now = new Date("2026-11-19T12:00:00Z");

const event = (change: Partial<FoundEvent> = {}): FoundEvent => ({
  source: "TECHCONF",
  externalId: "1",
  title: "Android Dev Summit",
  summary: "Kotlin and Android for mobile engineers",
  url: "https://example.com/1",
  place: "Berlin, Germany",
  city: "Berlin",
  country: "de",
  remote: false,
  format: "IN_PERSON",
  startsAt: "2026-12-01T00:00:00.000Z",
  endsAt: null,
  ticketPrice: "",
  speakers: [],
  attendance: null,
  audience: "",
  ...change,
});

describe("event proximity", () => {
  it("ranks city before country before virtual before far", () => {
    expect(eventProximity(event(), berlin)).toBe(PROXIMITY_CITY);
    expect(eventProximity(event({ place: "Munich, Germany", city: "Munich" }), berlin)).toBe(PROXIMITY_COUNTRY);
    expect(eventProximity(event({ place: "Online", city: "", country: "", remote: true, format: "VIRTUAL", title: "Remote Android" }), berlin)).toBe(
      PROXIMITY_VIRTUAL,
    );
    expect(eventProximity(event({ place: "Austin, TX", city: "Austin", country: "us", title: "UX Summit" }), berlin)).toBe(PROXIMITY_FAR);
  });
});

describe("event match", () => {
  it("scores nearer events higher for the same skills", () => {
    const profile = {
      basics: { headline: "Android engineer", summary: "", city: "Berlin", country: "Germany" },
      skills: [
        { id: "1", name: "Android" },
        { id: "2", name: "Kotlin" },
      ],
      experience: [],
    } as unknown as Pick<ProfileData, "basics" | "skills" | "experience">;
    const city = matchEvent(event(), profile, berlin, now);
    const far = matchEvent(event({ place: "Austin, TX", city: "Austin", country: "us", title: "Android in Austin" }), profile, berlin, now);
    const hybrid = matchEvent(event({ place: "Online", city: "", country: "", remote: true, format: "HYBRID", title: "Android hybrid" }), profile, berlin, now);
    const past = matchEvent(event({ startsAt: "2026-01-01T00:00:00.000Z", title: "Past Android" }), profile, berlin, now);
    const soon = matchEvent(
      event({
        startsAt: "2026-11-20T00:00:00.000Z",
        ticketPrice: "€50",
        speakers: ["Ada", "Grace"],
        title: "Android tomorrow",
      }),
      profile,
      berlin,
      now,
    );
    const country = matchEvent(event({ place: "Munich, Germany", city: "Munich", title: "Android Munich" }), profile, berlin, now);
    expect(city.proximity).toBe(PROXIMITY_CITY);
    expect(far.proximity).toBe(PROXIMITY_FAR);
    expect(hybrid.proximity).toBe(PROXIMITY_VIRTUAL);
    expect(country.proximity).toBe(PROXIMITY_COUNTRY);
    expect(city.score).toBeGreaterThan(far.score);
    expect(city.score).toBeGreaterThan(past.score);
    expect(soon.score).toBeGreaterThan(city.score);
    expect(city.reasons.some((reason) => /Android|Kotlin/i.test(reason))).toBe(true);
    expect(soon.reasons.some((reason) => /today|tomorrow|days/i.test(reason))).toBe(true);
  });
});
