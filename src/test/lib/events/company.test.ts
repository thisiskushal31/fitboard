import { describe, expect, it } from "vitest";

import {
  eventsFromAwsCards,
  eventsFromGdg,
  eventsFromJsonLd,
  eventsFromMongodb,
} from "@/lib/events/sources/company";

const aws = { id: "aws", name: "AWS", parser: "aws-cards" as const, pages: [] };
const gcp = { id: "gcp", name: "Google Cloud", parser: "gdg" as const, pages: [] };
const mongo = { id: "mongodb", name: "MongoDB", parser: "mongodb" as const, pages: [] };

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
        ],
      },
      gcp,
      "2026-11-20",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "COMPANY",
      title: "Google Cloud: Cloud Community Day Pune",
      city: "Pune",
      country: "in",
    });
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
});
