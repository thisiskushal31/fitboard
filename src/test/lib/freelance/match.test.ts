import { describe, expect, it } from "vitest";

import { matchFreelance } from "@/lib/freelance/match";
import type { FoundFreelance } from "@/lib/freelance/types";
import type { ProfileData } from "@/lib/profile/profile";
import { placeOf } from "@/lib/startups/place";

const berlin = placeOf({ city: "Berlin", country: "Germany" });
const now = new Date("2026-11-19T12:00:00Z");

const gig = (change: Partial<FoundFreelance> = {}): FoundFreelance => ({
  source: "HN",
  externalId: "1",
  title: "Contract Android engineer",
  company: "Acme",
  place: "Berlin, Germany",
  remote: false,
  engagement: "CONTRACT",
  budget: "$80/hr",
  duration: "3 months",
  url: "https://example.com/1",
  description: "Need Kotlin and Android for a mobile app contract.",
  postedAt: "2026-11-01T00:00:00.000Z",
  ...change,
});

describe("freelance match", () => {
  it("scores matching skills higher and still ranks remote open work", () => {
    const profile = {
      basics: { headline: "Android engineer", summary: "", city: "Berlin", country: "Germany" },
      skills: [
        { id: "1", name: "Android" },
        { id: "2", name: "Kotlin" },
      ],
      experience: [],
    } as unknown as Pick<ProfileData, "basics" | "skills" | "experience">;

    const local = matchFreelance(gig(), profile, berlin, now);
    const remote = matchFreelance(gig({ place: "Remote", remote: true, title: "Remote Android contract", description: "Android Kotlin remote" }), profile, berlin, now);
    const unrelated = matchFreelance(gig({ title: "Logo design", description: "Figma only", place: "Austin, TX", remote: false }), profile, berlin, now);

    expect(local.score).toBeGreaterThan(unrelated.score);
    expect(remote.score).toBeGreaterThan(0);
    expect(local.reasons.some((reason) => /Android|Kotlin/i.test(reason))).toBe(true);
  });
});
