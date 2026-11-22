import { beforeEach, describe, expect, it, vi } from "vitest";

import { enrichEventPlaces } from "@/lib/events/place-learn";
import type { FoundEvent } from "@/lib/events/types";

const db = vi.hoisted(() => ({
  rows: [] as { key: string; name: string; country: string; continent: string }[],
}));

vi.mock("@/lib/core/prisma", () => ({
  prisma: {
    eventPlace: {
      findMany: async () => db.rows,
      upsert: async ({ where, create }: { where: { key: string }; create: (typeof db.rows)[number] }) => {
        const index = db.rows.findIndex((row) => row.key === where.key);
        if (index >= 0) db.rows[index] = { ...db.rows[index], ...create };
        else db.rows.push(create);
        return create;
      },
    },
  },
}));

const event = (change: Partial<FoundEvent> = {}): FoundEvent => ({
  source: "TECHMEETUPS",
  externalId: "1",
  title: "Summit",
  summary: "",
  url: "https://example.com",
  place: "",
  city: "",
  country: "",
  remote: false,
  format: "IN_PERSON",
  startsAt: null,
  endsAt: null,
  ticketPrice: "",
  speakers: [],
  attendance: null,
  audience: "",
  ...change,
});

beforeEach(() => {
  db.rows = [];
  vi.unstubAllGlobals();
});

describe("enrichEventPlaces", () => {
  it("learns a new city when the source already gave a country", async () => {
    const [out] = await enrichEventPlaces([event({ city: "Zaragoza", country: "es", place: "Zaragoza, Spain" })]);
    expect(out).toMatchObject({ city: "Zaragoza", country: "es", place: "Zaragoza, Europe" });
    expect(db.rows.some((row) => row.key === "zaragoza" && row.country === "es")).toBe(true);
  });

  it("geocodes an unknown city once and remembers it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          {
            name: "Akureyri",
            address: { city: "Akureyri", country_code: "is" },
          },
        ]),
      ),
    );
    const [out] = await enrichEventPlaces([event({ city: "SomeNewTown", place: "SomeNewTown" })]);
    expect(out).toMatchObject({ city: "Akureyri", country: "is", place: "Akureyri, Europe" });
    expect(db.rows.some((row) => row.key === "akureyri" && row.country === "is")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("leaves the event alone when geocoding fails or returns no country", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const [failed] = await enrichEventPlaces([event({ city: "Nowhereville", place: "Nowhereville" })]);
    expect(failed?.city).toBe("Nowhereville");
    expect(db.rows).toHaveLength(0);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json([{ name: "X", address: { town: "X" } }])));
    const [noCountry] = await enrichEventPlaces([event({ city: "GhostTown", place: "GhostTown" })]);
    expect(noCountry?.country).toBe("");
  });

  it("keeps virtual events online without geocoding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const [out] = await enrichEventPlaces([event({ format: "VIRTUAL", place: "Remote", city: "", remote: true })]);
    expect(out).toMatchObject({ place: "Online", city: "", country: "" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
