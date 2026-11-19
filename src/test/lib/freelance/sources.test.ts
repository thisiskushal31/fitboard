import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchFreelancerFreelance } from "@/lib/freelance/sources/freelancer";
import { fetchHnFreelance, freelanceFromHnPost } from "@/lib/freelance/sources/hn";
import { getJson, getText, SourceError } from "@/lib/freelance/sources/http";
import { fetchRemoteOkFreelance } from "@/lib/freelance/sources/remoteok";
import { fetchRemotiveFreelance } from "@/lib/freelance/sources/remotive";
import { itemsFromRss } from "@/lib/freelance/sources/rss";
import { fetchWwrFreelance } from "@/lib/freelance/sources/wwr";
import { placeOf } from "@/lib/startups/place";

const berlin = placeOf({ city: "Berlin", country: "Germany" });
const anywhere = placeOf({ city: "", country: "" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("freelance HTTP helpers", () => {
  it("turns network failures into SourceError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    await expect(getText("https://example.com/feed")).rejects.toMatchObject({ name: "SourceError", message: "couldn't be reached" });
  });

  it("turns HTTP errors and bad JSON into SourceError", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    await expect(getText("https://example.com/feed")).rejects.toMatchObject({ name: "SourceError", message: "answered with an error (503)" });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })));
    await expect(getJson("https://example.com/api")).rejects.toMatchObject({ name: "SourceError", message: "didn't answer with JSON" });
  });

  it("reports when the caller aborted the request", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("Aborted", "AbortError");
      }),
    );
    await expect(getText("https://example.com/feed", { signal: controller.signal })).rejects.toMatchObject({
      name: "SourceError",
      message: "was stopped",
    });
  });
});

describe("RSS item parsing", () => {
  it("reads items and skips broken blocks", () => {
    const xml = `
      <rss><channel>
        <item><title>Build an app</title><link>https://x.example/1</link><description>Need React</description><pubDate>Wed, 01 Oct 2026 12:00:00 GMT</pubDate></item>
        <item><title></title><link></link></item>
        <item><title>Design work</title><link>https://x.example/2</link><description><![CDATA[<p>Logo</p>]]></description></item>
      </channel></rss>`;
    expect(itemsFromRss(xml)).toEqual([
      { title: "Build an app", link: "https://x.example/1", description: "Need React", pubDate: "Wed, 01 Oct 2026 12:00:00 GMT" },
      { title: "Design work", link: "https://x.example/2", description: "Logo", pubDate: "" },
    ]);
    expect(itemsFromRss("")).toEqual([]);
  });
});

describe("Remotive / Remote OK / Freelancer parsers", () => {
  it("keeps Remotive contract rows and rejects a bad payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          jobs: [
            { id: 1, title: "Contract React engineer", url: "https://remotive.com/1", job_type: "contract", company_name: "Acme", description: "React" },
            { id: 2, title: "Full-time engineer", url: "https://remotive.com/2", job_type: "full_time", description: "Permanent role" },
            { id: 3, title: "Broken" },
          ],
        }),
      ),
    );
    await expect(fetchRemotiveFreelance()).resolves.toMatchObject([{ source: "REMOTIVE", externalId: "1", title: "Contract React engineer" }]);

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ nope: true })));
    await expect(fetchRemotiveFreelance()).rejects.toBeInstanceOf(SourceError);
  });

  it("skips Remote OK's legal row and non-contract jobs", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          { legal: "API terms" },
          { id: 10, position: "Contract backend", company: "Co", url: "https://remoteok.com/10", tags: ["contract"], description: "Node", salary_min: 80, salary_max: 100 },
          { id: 11, position: "Staff engineer", company: "Co", url: "https://remoteok.com/11", tags: ["full-time"], description: "Permanent" },
          { id: 12, position: "Temporary support", company: "Co", url: "https://remoteok.com/12", tags: ["temporary"], description: "Temp help", salary_min: 40 },
          { id: 13, position: "Broken" },
        ]),
      ),
    );
    const jobs = await fetchRemoteOkFreelance();
    expect(jobs.map((job) => job.externalId).sort()).toEqual(["10", "12"]);
    expect(jobs.find((job) => job.externalId === "10")?.budget).toMatch(/100/);
    expect(jobs.find((job) => job.externalId === "12")?.engagement).toBe("TEMPORARY");

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ nope: true })));
    await expect(fetchRemoteOkFreelance()).rejects.toBeInstanceOf(SourceError);
  });

  it("reads Freelancer.com RSS and fails clearly when every feed is down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("rss.xml")) {
          return new Response(
            `<rss><channel><item><title>Need a mobile app</title><link>https://www.freelancer.com/projects/1</link><description>Budget $500</description></item></channel></rss>`,
            { status: 200 },
          );
        }
        return new Response("gone", { status: 404 });
      }),
    );
    const jobs = await fetchFreelancerFreelance();
    expect(jobs).toMatchObject([{ source: "FREELANCER", title: "Need a mobile app", url: "https://www.freelancer.com/projects/1" }]);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 503 })));
    await expect(fetchFreelancerFreelance()).rejects.toMatchObject({ name: "SourceError", message: "answered with an error (503)" });
  });

  it("reads WWR contracting and contract-marked programming feeds", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("contracting")) {
          return new Response(
            `<rss><channel>
              <item><title>Acme: Contract React</title><link>https://weworkremotely.com/1</link><description>Remote contract</description><pubDate>Wed, 01 Oct 2026 12:00:00 GMT</pubDate></item>
              <item><title>Temp ops</title><link>https://weworkremotely.com/2</link><description>temporary short-term</description></item>
            </channel></rss>`,
          );
        }
        if (String(url).includes("full-stack")) {
          return new Response(
            `<rss><channel>
              <item><title>Beta: Full-time engineer</title><link>https://weworkremotely.com/3</link><description>Permanent role</description></item>
              <item><title>Gamma: Freelance API work</title><link>https://weworkremotely.com/4</link><description>Need a freelancer for a project</description></item>
            </channel></rss>`,
          );
        }
        return new Response("gone", { status: 503 });
      }),
    );
    const jobs = await fetchWwrFreelance();
    expect(jobs.map((job) => job.url).sort()).toEqual([
      "https://weworkremotely.com/1",
      "https://weworkremotely.com/2",
      "https://weworkremotely.com/4",
    ]);
    expect(jobs.find((job) => job.url.endsWith("/2"))?.engagement).toBe("TEMPORARY");
    expect(jobs.find((job) => job.url.endsWith("/4"))?.engagement).toBe("PROJECT");

    vi.stubGlobal("fetch", vi.fn(async () => new Response("gone", { status: 503 })));
    await expect(fetchWwrFreelance()).rejects.toBeInstanceOf(SourceError);
  });
});

describe("Hacker News freelancer thread", () => {
  it("keeps client posts that seek freelancers and drops seekers of work", () => {
    const client = freelanceFromHnPost(
      {
        id: 101,
        text: "Acme Corp | REMOTE | Seeking a freelance React engineer for a three-month project. Budget $80/hr. https://acme.example",
        created_at: "2026-11-01T00:00:00.000Z",
      },
      anywhere,
    );
    expect(client).toMatchObject({
      source: "HN",
      externalId: "101",
      company: "Acme Corp",
      engagement: "PROJECT",
      budget: "$80/hr",
      remote: true,
    });

    expect(
      freelanceFromHnPost(
        {
          id: 102,
          text: "Available for hire — looking for freelance React work. Hire me for your next contract.",
          created_at: "2026-11-01T00:00:00.000Z",
        },
        anywhere,
      ),
    ).toBeNull();

    expect(
      freelanceFromHnPost(
        {
          id: 103,
          text: "Short note",
          created_at: "2026-11-01T00:00:00.000Z",
        },
        berlin,
      ),
    ).toBeNull();

    expect(
      freelanceFromHnPost(
        {
          id: 104,
          text: "Austin Studios | ON-SITE Austin TX | Looking for a freelance contractor for six months. Rate $70/hr.",
          created_at: "2026-11-01T00:00:00.000Z",
        },
        berlin,
      ),
    ).toBeNull();

    expect(
      freelanceFromHnPost(
        {
          id: 105,
          text: "Berlin Labs | Berlin | Seeking a temporary short-term consultant for a few weeks. Budget $60/hr.",
          created_at: "2026-11-01T00:00:00.000Z",
        },
        berlin,
      ),
    ).toMatchObject({ engagement: "TEMPORARY", remote: false });
  });

  it("reads this month's thread and fails clearly when it is missing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (String(url).includes("search_by_date")) {
          return Response.json({
            hits: [{ objectID: "999", title: "Ask HN: Freelancer? Seeking freelancer? (November 2026)" }],
          });
        }
        return Response.json({
          children: [
            {
              id: 201,
              text: "Berlin Labs | Berlin / REMOTE | Looking for a freelance Kotlin contractor. Budget $90/hr for a months contract.",
              created_at: "2026-11-02T00:00:00.000Z",
            },
            { id: 202, text: "too short" },
            { broken: true },
          ],
        });
      }),
    );
    const jobs = await fetchHnFreelance(berlin);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ source: "HN", externalId: "201", engagement: "TEMPORARY" });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ hits: [{ objectID: "1", title: "Who is hiring?" }] })));
    await expect(fetchHnFreelance(anywhere)).rejects.toMatchObject({ name: "SourceError", message: "has no freelancer thread this month" });

    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ nope: true })));
    await expect(fetchHnFreelance(anywhere)).rejects.toMatchObject({ name: "SourceError", message: "changed its format" });
  });
});
