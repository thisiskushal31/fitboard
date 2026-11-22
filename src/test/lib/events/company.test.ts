import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../config/company-events.json", () => ({
  default: {
    companies: [
      { id: "aws", name: "AWS", parser: "aws-cards", pages: ["https://example.com/aws"] },
      { id: "gcp", name: "Google Cloud", parser: "gdg", pages: ["https://gdg.community.dev/api/search/"] },
      { id: "mongodb", name: "MongoDB", parser: "mongodb", pages: ["https://example.com/events/mongodb-local/berlin"] },
      { id: "cloudflare", name: "Cloudflare", parser: "json-ld", pages: ["https://example.com/cf"] },
      { id: "microsoft", name: "Microsoft", parser: "html-events", pages: ["https://example.com/ms"] },
    ],
  },
}));

import {
  eventsFromAwsCards,
  eventsFromGdg,
  eventsFromHtmlHeuristics,
  eventsFromJsonLd,
  eventsFromMongodb,
  fetchCompanyEvents,
} from "@/lib/events/sources/company";
import { SourceError } from "@/lib/events/sources/http";

const aws = { id: "aws", name: "AWS", parser: "aws-cards" as const, pages: [] };
const gcp = { id: "gcp", name: "Google Cloud", parser: "gdg" as const, pages: [] };
const mongo = { id: "mongodb", name: "MongoDB", parser: "mongodb" as const, pages: [] };
const htmlCo = { id: "microsoft", name: "Microsoft", parser: "html-events" as const, pages: [] };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("company event parsers", () => {
  it("reads AWS CMS summit cards and skips past on-demand dates", () => {
    const html = `
      {"fields":{"itemBody":"AWS Summit Dubai 2026 is free.","itemCTALink":"/events/summits/dubai/","itemMetaDate":"2026-12-15","itemTitle":"AWS Summit Dubai 2026","id":"ams#c2","itemMetaLocation":"Dubai World Trade Center","itemBadge":""}}
      {"fields":{"itemBody":"Past","itemCTALink":"/events/summits/old/","itemMetaDate":"2025-01-01","itemTitle":"AWS Summit Old","id":"ams#old","itemMetaLocation":"Somewhere","itemBadge":"On Demand"}}
    `;
    const events = eventsFromAwsCards(html, "https://aws.amazon.com/events/summits/", aws, "2026-11-20");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "COMPANY",
      title: "AWS Summit Dubai 2026",
      city: "Dubai",
      country: "ae",
      format: "IN_PERSON",
    });
    expect(events[0]!.url).toContain("/events/summits/dubai/");
    expect(events[0]!.place).toMatch(/Asia|Middle East/);
  });

  it("falls back to itemTitle windows and skips on-demand without a date", () => {
    const html = `
      "itemTitle": "AWS Community Day Online",
      "itemCTAHref": "https://aws.amazon.com/events/community-day/online/",
      "itemBadge": "On Demand",
      "itemBody": "Virtual only",
      "itemTitle": "AWS Community Day Online",
      "itemMetaDate": "2026-12-01",
      "itemCTALink": "/events/community-day/online/",
      "location": "Online",
      "id": "cd#1"
    `;
    const events = eventsFromAwsCards(html, "https://aws.amazon.com/events/community-day/", aws, "2026-11-20");
    expect(events.some((event) => event.format === "VIRTUAL" && /Community Day/i.test(event.title))).toBe(true);
  });

  it("parses re:Invent hero copy when there are no CMS cards", () => {
    const html = `<html><body><h1>AWS re:Invent</h1><p>Nov. 30 – Dec. 4, 2026 in Las Vegas</p></body></html>`;
    const events = eventsFromAwsCards(html, "https://aws.amazon.com/events/reinvent/", aws, "2026-11-01");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      title: "AWS re:Invent 2026",
      city: "Las Vegas",
      country: "us",
      startsAt: "2026-11-30T00:00:00.000Z",
    });
  });

  it("decodes escaped AWS field strings and drops empty titles", () => {
    const html = `{"fields":{"itemTitle":"Summit \\u0041","itemMetaDate":"not-a-date","itemCTALink":"/a/","itemBody":"line\\n dual \\"quote\\"","id":"x","itemMetaLocation":"Tel Aviv Expo"}}`;
    const events = eventsFromAwsCards(html, "https://aws.amazon.com/events/", aws, "2026-11-20");
    expect(events[0]?.title).toContain("Summit A");
    expect(events[0]?.city).toBe("Tel Aviv");
    expect(events[0]?.startsAt).toBeNull();
  });

  it("parses Google Cloud community events from the GDG API", () => {
    const events = eventsFromGdg(
      {
        results: [
          {
            id: 1,
            title: "Cloud Community Day Pune",
            description_short: "Google Cloud community day",
            city: "Pune",
            start_date: "2026-12-06T10:00:00+05:30",
            url: "https://gdg.community.dev/events/details/ccd-pune/",
            chapter: { city: "Pune", country: "IN", country_name: "India", chapter_location: "Pune, India" },
            tags: ["Google Cloud"],
          },
          {
            id: 2,
            title: "Old meetup",
            start_date: "2025-01-01T10:00:00Z",
            url: "https://gdg.community.dev/old/",
            chapter: { city: "Pune", country: "IN" },
          },
          {
            id: 3,
            title: "Cloud OnAir",
            start_date: "2026-12-20T18:00:00Z",
            url: "https://gdg.community.dev/onair/",
            chapter: { city: "", country_name: "United States" },
            tags: ["onair"],
          },
          { id: 3, title: "Cloud OnAir", start_date: "2026-12-20T18:00:00Z", url: "https://gdg.community.dev/onair/" },
          { title: "", start_date: "2026-12-01", url: "https://gdg.community.dev/x/" },
        ],
      },
      gcp,
      "2026-11-20",
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      source: "COMPANY",
      title: "Google Cloud: Cloud Community Day Pune",
      city: "Pune",
      country: "in",
    });
    expect(events[1]).toMatchObject({ format: "VIRTUAL", title: expect.stringContaining("Cloud OnAir") });
  });

  it("rejects a GDG payload without results", () => {
    expect(() => eventsFromGdg({ nope: true }, gcp, "2026-11-20")).toThrow(SourceError);
  });

  it("reads MongoDB.local city pages from the date and path", () => {
    const html = `<html><body><h1>MongoDB.local Toronto</h1><p>November 19, 2026</p><p>Steam Whistle Brewing</p></body></html>`;
    const events = eventsFromMongodb(html, "https://www.mongodb.com/events/mongodb-local/toronto", mongo, "2026-11-01");
    expect(events.some((event) => /Toronto/i.test(event.title) && event.startsAt?.startsWith("2026-11-19"))).toBe(true);
  });

  it("reads JSON-LD Event blocks", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@context": "https://schema.org",
      "@type": "Event",
      name: "Cloudflare Connect",
      url: "https://www.cloudflare.com/events/connect/",
      startDate: "2026-12-10",
      location: { "@type": "Place", name: "San Francisco", address: { addressLocality: "San Francisco", addressCountry: "US" } },
    })}</script>`;
    const events = eventsFromJsonLd(html, "https://www.cloudflare.com/events/", { id: "cloudflare", name: "Cloudflare", parser: "json-ld", pages: [] }, "2026-11-20");
    expect(events[0]).toMatchObject({
      title: "Cloudflare Connect",
      city: "San Francisco",
      country: "us",
    });
  });

  it("walks JSON-LD graphs, lists, string locations, and online attendance", () => {
    const html = `
      <script type="application/ld+json">not-json</script>
      <script type="application/ld+json">${JSON.stringify({
        "@graph": [
          {
            "@type": ["Event", "Thing"],
            name: "HashiConf Online",
            "@id": "https://example.com/hashiconf",
            startDate: "2026-12-01T09:00:00Z",
            endDate: "2026-12-02T17:00:00Z",
            description: "Infra conference",
            eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode",
            location: "Online",
          },
        ],
      })}</script>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "ItemList",
        itemListElement: [
          {
            item: {
              "@type": "Event",
              name: "Past Event",
              url: "https://example.com/past",
              startDate: "2025-01-01",
              location: { name: "Hall", address: "Berlin, Germany" },
            },
          },
          {
            "@type": "Event",
            name: "KubeCon EU",
            url: "/events/kubecon",
            startDate: "2026-12-15",
            location: {
              name: "Messe",
              address: { addressLocality: "Amsterdam", addressRegion: "NH", addressCountry: "NL" },
            },
          },
        ],
      })}</script>
    `;
    const events = eventsFromJsonLd(html, "https://example.com/events/", htmlCo, "2026-11-20");
    expect(events.some((event) => event.format === "VIRTUAL" && /HashiConf/i.test(event.title))).toBe(true);
    expect(events.some((event) => event.city === "Amsterdam" && event.url.includes("/events/kubecon"))).toBe(true);
    expect(events.every((event) => !/Past Event/i.test(event.title))).toBe(true);
  });

  it("finds dated headings in HTML event hubs", () => {
    const html = `
      <h2>Ignite Virtual Conference</h2>
      <p>2026-12-18</p>
      <a href="/events/build">Build 2027 Summit</a>
      <span>March 15, 2027</span>
      <h2>Privacy policy</h2>
      <p>2026-12-20</p>
    `;
    const events = eventsFromHtmlHeuristics(html, "https://example.com/ms/events", htmlCo, "2026-11-20");
    expect(events.some((event) => /Ignite Virtual/i.test(event.title) && event.format === "VIRTUAL")).toBe(true);
    expect(events.some((event) => /Build 2027/i.test(event.title))).toBe(true);
    expect(events.every((event) => !/Privacy/i.test(event.title))).toBe(true);
  });
});

describe("fetchCompanyEvents", () => {
  it("scrapes each parser kind and dedupes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("gdg.community.dev")) {
          return Response.json({
            results: [
              {
                id: 9,
                title: "DevFest",
                start_date: "2026-12-12T10:00:00Z",
                url: "https://gdg.community.dev/devfest/",
                chapter: { city: "Berlin", country: "DE", country_name: "Germany" },
              },
            ],
          });
        }
        if (url.includes("/aws")) {
          return new Response(
            `{"fields":{"itemTitle":"AWS Summit Berlin","itemMetaDate":"2026-12-05","itemCTALink":"/berlin/","itemMetaLocation":"Berlin","id":"b1","itemBody":"","itemBadge":""}}`,
            { status: 200, headers: { "content-type": "text/html" } },
          );
        }
        if (url.includes("mongodb-local")) {
          return new Response(`<h1>MongoDB.local Berlin</h1><p>December 8, 2026</p>`, { status: 200 });
        }
        if (url.includes("/cf")) {
          return new Response(
            `<script type="application/ld+json">${JSON.stringify({
              "@type": "Event",
              name: "Cloudflare Meetup",
              url: "https://example.com/cf/meetup",
              startDate: "2026-12-09",
              location: { address: { addressLocality: "London", addressCountry: "GB" } },
            })}</script>`,
            { status: 200 },
          );
        }
        return new Response(`<h2>Microsoft Build Online</h2><p>2026-12-11</p>`, { status: 200 });
      }),
    );

    const events = await fetchCompanyEvents(undefined, new Date("2026-11-20T00:00:00Z"));
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events.every((event) => event.source === "COMPANY")).toBe(true);
    expect(new Set(events.map((event) => event.externalId)).size).toBe(events.length);
  });

  it("surfaces SourceError when every page fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(fetchCompanyEvents(undefined, new Date("2026-11-20T00:00:00Z"))).rejects.toMatchObject({
      name: "SourceError",
      message: expect.stringMatching(/error \(503\)|did not answer/),
    });
  });

  it("rejects oversized bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("tiny", { status: 200, headers: { "content-length": String(2_000_000) } })),
    );
    await expect(fetchCompanyEvents(undefined, new Date("2026-11-20T00:00:00Z"))).rejects.toBeInstanceOf(SourceError);
  });

  it("maps network failures and empty bodies to SourceError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(fetchCompanyEvents(undefined, new Date("2026-11-20T00:00:00Z"))).rejects.toMatchObject({
      name: "SourceError",
      message: "couldn't be reached",
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 200 })));
    await expect(fetchCompanyEvents(undefined, new Date("2026-11-20T00:00:00Z"))).rejects.toMatchObject({
      name: "SourceError",
      message: "couldn't be read",
    });
  });

  it("stops when the caller aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        return new Response("ok", { status: 200 });
      }),
    );
    await expect(fetchCompanyEvents(controller.signal, new Date("2026-11-20T00:00:00Z"))).rejects.toMatchObject({
      name: "SourceError",
      message: "was stopped",
    });
  });

  it("falls back from empty JSON-LD to HTML heuristics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("gdg.community.dev")) return Response.json({ results: [] });
        if (url.includes("/cf")) {
          return new Response(`<h2>Workers Launchpad</h2><p>2026-12-22</p>`, { status: 200 });
        }
        return new Response(`{"fields":{"itemTitle":"AWS Summit Berlin","itemMetaDate":"2026-12-05","itemCTALink":"/b/","id":"1","itemMetaLocation":"Berlin","itemBody":"","itemBadge":""}}`, {
          status: 200,
        });
      }),
    );
    const events = await fetchCompanyEvents(undefined, new Date("2026-11-20T00:00:00Z"));
    expect(events.some((event) => /Workers Launchpad/i.test(event.title))).toBe(true);
  });

  it("rejects a body that grows past the byte cap while streaming", async () => {
    const chunk = new Uint8Array(400_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        let n = 0;
        const stream = new ReadableStream<Uint8Array>({
          pull(controller) {
            n += 1;
            if (n <= 5) controller.enqueue(chunk);
            else controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }),
    );
    await expect(fetchCompanyEvents(undefined, new Date("2026-11-20T00:00:00Z"))).rejects.toMatchObject({
      name: "SourceError",
      message: "sent too much",
    });
  });
});
