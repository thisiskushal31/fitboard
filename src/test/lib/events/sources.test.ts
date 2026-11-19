import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchConfsTechEvents } from "@/lib/events/sources/confstech";
import { getJson, getText, SourceError } from "@/lib/events/sources/http";
import { eventsFromIcs, icsDateToIso } from "@/lib/events/sources/ics";
import { fetchMeetupEvents } from "@/lib/events/sources/meetup";
import { fetchTechConfEvents } from "@/lib/events/sources/techconf";
import { fetchTechMeetupsEvents } from "@/lib/events/sources/techmeetups";

vi.mock("node:fs/promises", () => ({
  readFile: async () =>
    JSON.stringify([
      { slug: "reactjsdallas", name: "ReactJS Dallas" },
      { slug: "berlin-js", name: "BerlinJS" },
    ]),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("events HTTP helpers", () => {
  it("turns network failures into SourceError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(getText("https://example.com/api")).rejects.toMatchObject({ name: "SourceError", message: "couldn't be reached" });
  });

  it("turns HTTP errors and bad JSON into SourceError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(getText("https://example.com/api")).rejects.toMatchObject({ name: "SourceError", message: "answered with an error (503)" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));
    await expect(getJson("https://example.com/api")).rejects.toMatchObject({ name: "SourceError", message: "didn't answer with JSON" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(100), { status: 200, headers: { "content-length": String(6 * 1024 * 1024) } })));
    await expect(getText("https://example.com/api")).rejects.toMatchObject({ name: "SourceError", message: "sent too much" });

    const { settledInBatches } = await import("@/lib/events/sources/http");
    const results = await settledInBatches([1, 2, 3, 4], 2, async (n) => n * 2);
    expect(results.map((result) => (result.status === "fulfilled" ? result.value : null))).toEqual([2, 4, 6, 8]);
  });
});

describe("TechConf and TechMeetups parsers", () => {
  it("keeps upcoming TechConf events and skips past ones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          data: [
            {
              id: "android-berlin",
              title: "Android Berlin",
              tags: ["android", "kotlin"],
              upcoming_events: {
                "2026": {
                  dates: { start: "2026-12-10", end: "2026-12-11" },
                  format: "in-person",
                  location: { city: "Berlin", country: "DE" },
                },
              },
            },
            {
              id: "old-conf",
              title: "Old Conf",
              tags: ["php"],
              upcoming_events: {
                "2025": { dates: { start: "2025-01-01" }, format: "virtual", location: { city: "Remote", country: "US" } },
              },
            },
            {
              id: "remote-kt",
              title: "Virtual Kotlin",
              tags: [],
              upcoming_events: {
                "2026": { dates: { start: "2026-12-20" }, format: "virtual", location: { city: "", country: "" } },
              },
            },
            {
              id: "hybrid-ux",
              title: "Hybrid UX",
              upcoming_events: {
                "2026": { dates: { start: "2026-12-22" }, format: "hybrid", location: { city: "Munich", country: "Germany" } },
              },
            },
            { id: "broken" },
          ],
        }),
      ),
    );
    const events = await fetchTechConfEvents(undefined, new Date("2026-11-19T12:00:00Z"));
    expect(events.map((event) => event.title).sort()).toEqual(["Android Berlin", "Hybrid UX", "Virtual Kotlin"]);
    expect(events.find((event) => event.title === "Virtual Kotlin")).toMatchObject({ format: "VIRTUAL", remote: true });
    expect(events.find((event) => event.title === "Hybrid UX")).toMatchObject({ format: "HYBRID", remote: true });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ nope: true })));
    await expect(fetchTechConfEvents()).rejects.toMatchObject({ name: "SourceError", message: "changed its format" });
  });

  it("reads TechMeetups results and fails when every focus is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("focus=startups")) return new Response("gone", { status: 503 });
        return Response.json({
          results: [
            {
              id: "ai-sf-2026",
              name: "AI Summit",
              start_date: "2026-12-01",
              end_date: "2026-12-02",
              location: "San Francisco, CA",
              city: "san-francisco",
              focus: "ai-ml",
              topics: ["llm"],
              description: "Join Irene Solaiman, Chief Policy Officer at Hugging Face, for a talk. 500 attendees expected. Senior staff welcome.",
              cost: "Free",
              registration_url: "https://lu.ma/ai",
              url: "https://techmeetups.io/conferences/ai-sf-2026",
            },
            {
              id: "hybrid-berlin",
              name: "Hybrid Builders Day",
              start_date: "2026-12-05",
              location: "Berlin, Germany",
              description: "A hybrid hackathon for builders on campus with university students.",
              url: "https://techmeetups.io/hybrid",
            },
            {
              id: "online-leaders",
              name: "Remote Leadership",
              start_date: "2026-12-08",
              location: "Remote",
              description: "Online virtual summit for executives and directors.",
              url: "https://techmeetups.io/leaders",
            },
            {
              id: "onsite-dev",
              name: "On-site Dev Day",
              start_date: "2026-12-09",
              location: "Austin, US",
              description: "In-person onsite conference.",
              url: "https://techmeetups.io/onsite",
            },
            { id: "broken", name: "No URL" },
            { id: "ai-sf-2026", name: "Duplicate", url: "https://techmeetups.io/dup" },
          ],
          total_matches: 6,
        });
      }),
    );
    const events = await fetchTechMeetupsEvents(undefined, new Date("2026-11-19T12:00:00Z"));
    expect(events.some((event) => event.title === "AI Summit" && event.ticketPrice === "Free")).toBe(true);
    expect(events.find((event) => event.title === "AI Summit")?.speakers.some((name) => /Irene/i.test(name))).toBe(true);
    expect(events.find((event) => event.title === "AI Summit")?.audience).toMatch(/Senior/);
    expect(events.find((event) => event.title === "Hybrid Builders Day")).toMatchObject({ format: "HYBRID", remote: true, audience: "Students and early career" });
    expect(events.find((event) => event.title === "Remote Leadership")).toMatchObject({ format: "VIRTUAL", audience: "Leaders and executives" });
    expect(events.find((event) => event.title === "On-site Dev Day")).toMatchObject({ format: "IN_PERSON", country: "us" });
    expect(events.filter((event) => event.externalId === "ai-sf-2026")).toHaveLength(1);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ results: "nope" })));
    await expect(fetchTechMeetupsEvents()).rejects.toMatchObject({ name: "SourceError", message: "changed its format" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 503 })));
    await expect(fetchTechMeetupsEvents()).rejects.toBeInstanceOf(SourceError);
  });

  it("parses ICS and Meetup calendars, and confs.tech topic lists", async () => {
    expect(icsDateToIso("20261210T180000Z")).toBe("2026-12-10T18:00:00.000Z");
    expect(
      eventsFromIcs(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:123456789@meetup.com
SUMMARY:JS Meetup
DESCRIPTION:50 going\\nFree event
LOCATION:Berlin\, Germany
URL:https://www.meetup.com/berlin-js/events/123456789/
DTSTART:20261210T180000Z
DTEND:20261210T200000Z
END:VEVENT
END:VCALENDAR`),
    ).toMatchObject([{ summary: "JS Meetup", location: "Berlin, Germany", startsAt: "2026-12-10T18:00:00.000Z" }]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("meetup.com")) {
          return new Response(`BEGIN:VCALENDAR
BEGIN:VEVENT
UID:999@meetup.com
SUMMARY:Android Night
DESCRIPTION:120 going
LOCATION:Berlin\, Germany
URL:https://www.meetup.com/berlin-js/events/999/
DTSTART:20261215T170000Z
END:VEVENT
BEGIN:VEVENT
UID:online@meetup.com
SUMMARY:Online Zoom Night
DESCRIPTION:Free event
LOCATION:Online
DTSTART:20261216T170000Z
END:VEVENT
BEGIN:VEVENT
UID:old@meetup.com
SUMMARY:Past Night
DESCRIPTION:10 going
LOCATION:US
DTSTART:20250101T170000Z
END:VEVENT
BEGIN:VEVENT
UID:nosummary@meetup.com
DESCRIPTION:x
DTSTART:20261217T170000Z
END:VEVENT
END:VCALENDAR`);
        }
        if (String(url).includes("conference-data")) {
          return Response.json([
            { name: "CityJS Berlin", url: "https://berlin.cityjsconf.org", startDate: "2026-12-20", endDate: "2026-12-21", city: "Berlin", country: "Germany", online: false },
            { name: "Past Conf", url: "https://example.com/past", startDate: "2025-01-01", city: "Berlin", country: "Germany" },
          ]);
        }
        return new Response("gone", { status: 404 });
      }),
    );

    const meetup = await fetchMeetupEvents(undefined, new Date("2026-11-19T12:00:00Z"));
    expect(meetup.some((event) => event.title === "Android Night" && event.attendance === 120)).toBe(true);
    expect(meetup.some((event) => event.title === "Online Zoom Night" && event.format === "VIRTUAL" && event.ticketPrice === "Free")).toBe(true);
    expect(meetup.every((event) => event.title !== "Past Night")).toBe(true);

    const confs = await fetchConfsTechEvents(undefined, new Date("2026-11-19T12:00:00Z"));
    expect(confs.some((event) => event.title === "CityJS Berlin" && event.source === "CONFSTECH")).toBe(true);
    expect(confs.every((event) => event.title !== "Past Conf")).toBe(true);

    expect(icsDateToIso("20261210")).toBe("2026-12-10T00:00:00.000Z");
    expect(icsDateToIso("")).toBeNull();
    expect(eventsFromIcs("BEGIN:VCALENDAR\nEND:VCALENDAR")).toEqual([]);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("conference-data") && String(url).includes("javascript")) {
          return Response.json([
            { name: "Online JS", url: "https://example.com/online", startDate: "2026-12-25", city: "Online", country: "Online", online: true },
          ]);
        }
        return new Response("gone", { status: 404 });
      }),
    );
    const online = await fetchConfsTechEvents(undefined, new Date("2026-11-19T12:00:00Z"));
    expect(online.some((event) => event.title === "Online JS" && event.format === "VIRTUAL" && event.remote === true)).toBe(true);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 503 })));
    await expect(fetchMeetupEvents()).rejects.toBeInstanceOf(SourceError);
    await expect(fetchConfsTechEvents()).rejects.toBeInstanceOf(SourceError);
  });
});
