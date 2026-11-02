import { afterEach, describe, expect, it, vi } from "vitest";

import { json, stubFetch } from "@/lib/ai/test-http";

import { filterPublicBoards, officialCareers, type CrawledPosting } from "@/lib/job-search/board-crawl";
import { EMPTY_QUERY } from "@/lib/job-search/search";

function posting(partial: Pick<CrawledPosting, "title" | "place"> & Partial<CrawledPosting>): CrawledPosting {
  return {
    externalId: partial.title,
    company: "Acme",
    remote: partial.place.toLowerCase().includes("remote"),
    salary: "",
    postedAt: null,
    url: "https://example.com/job",
    via: "Test",
    description: "",
    ...partial,
  };
}

const query = {
  keywords: "DevOps Engineer",
  place: "Mumbai",
  country: "in",
  remoteOnly: false,
  postedWithinDays: null,
};

describe("career links", () => {
  it("lists each employer once, even when two share a careers page", () => {
    const links = officialCareers();
    const keys = links.map((link) => `${link.name}\n${link.url}`);
    expect(new Set(keys).size).toBe(links.length);
    expect(links.filter((link) => link.url === "https://careers.jio.com/frmJobCategories.aspx").map((link) => link.name).sort()).toEqual(["Jio", "Jio Platforms"]);
  });
});

describe("public board location filter", () => {
  it("keeps a Mumbai role and drops a remote role based in other countries", () => {
    const mumbai = posting({ title: "DevOps Engineer", place: "Mumbai, India" });
    const bombay = posting({ title: "Senior DevOps Engineer", place: "Bombay" });
    const remoteElsewhere = posting({
      title: "Senior Back-end Developer",
      place: "Europe, USA, Canada, Australia, Singapore, Mexico, Saudi Arabia · Remote",
      description: "A devops engineer can work from those countries.",
    });
    const london = posting({
      title: "DevOps Engineer",
      place: "London, United Kingdom",
      description: "We also have an office in Mumbai.",
    });
    const bangalore = posting({ title: "DevOps Engineer", place: "Bangalore, India" });
    const indiaWide = posting({ title: "DevOps Engineer", place: "Remote - India" });
    const split = posting({ title: "DevOps Engineer", place: "India / UK" });

    const found = filterPublicBoards([remoteElsewhere, london, bangalore, split, indiaWide, mumbai, bombay], query).map((item) => item.place);

    expect(found).toEqual(["Mumbai, India", "Bombay", "Remote - India"]);
  });

  it("treats a zone as a part of the world, and Remote as every remote role", () => {
    const europe = posting({ title: "DevOps Engineer", place: "Remote, Europe" });
    const london = posting({ title: "DevOps Engineer", place: "London, United Kingdom", description: "A remote-friendly office." });
    const mumbai = posting({ title: "DevOps Engineer", place: "Mumbai, India" });
    const dubai = posting({ title: "DevOps Engineer", place: "Dubai, UAE" });
    const lagos = posting({ title: "DevOps Engineer", place: "Lagos, Nigeria" });

    const remote = filterPublicBoards([london, europe, mumbai], { ...query, place: "", country: "remote" }).map((item) => item.place);
    const apac = filterPublicBoards([london, europe, mumbai], { ...query, place: "", country: "apac" }).map((item) => item.place);
    const mea = filterPublicBoards([london, dubai, lagos, mumbai], { ...query, place: "", country: "mea" }).map((item) => item.place);

    expect(remote).toEqual(["Remote, Europe"]);
    expect(apac).toEqual(["Mumbai, India"]);
    expect(mea).toEqual(["Dubai, UAE", "Lagos, Nigeria"]);
  });

  it("with only a country, drops remote work that is closed to that country", () => {
    const india = posting({ title: "DevOps Engineer", place: "Pune, India" });
    const anywhere = posting({ title: "DevOps Engineer", place: "Remote" });
    const europe = posting({ title: "DevOps Engineer", place: "Remote, Europe" });

    const found = filterPublicBoards([europe, anywhere, india], { ...query, place: "" }).map((item) => item.place);

    expect(found).toEqual(["Pune, India", "Remote"]);
  });

  it("drops roles older than the window, and on-site roles when remote is required", () => {
    const recent = posting({ title: "DevOps Engineer", place: "Mumbai, India", postedAt: new Date().toISOString(), remote: false });
    const old = posting({ title: "DevOps Engineer", place: "Mumbai, India", postedAt: "2020-01-01T00:00:00.000Z", remote: true });
    const office = posting({ title: "DevOps Engineer", place: "Mumbai, India", remote: false, description: "In the office" });
    const remote = posting({ title: "DevOps Engineer", place: "Remote", remote: true });

    expect(filterPublicBoards([old, recent], { ...query, place: "", postedWithinDays: 7 }).map((item) => item.postedAt)).toEqual([recent.postedAt]);
    expect(filterPublicBoards([office, remote], { ...query, place: "", remoteOnly: true }).map((item) => item.place)).toEqual(["Remote"]);
  });
});

const devops = {
  title: "DevOps Engineer",
  description: "<p>Kubernetes &amp; Terraform</p>",
};

function boardResponse(url: URL, seen: Map<string, number>): Response {
  const host = url.hostname.replace(/^www\./, "");
  const kind = host.endsWith(".recruitee.com") ? "recruitee" : host;
  const nth = (seen.get(kind) ?? 0) + 1;
  seen.set(kind, nth);
  const slug = decodeURIComponent(url.pathname.split("/").filter(Boolean).pop() ?? "board");

  if (host === "boards-api.greenhouse.io") {
    if (nth === 2) return json({ error: "down" }, { status: 503 });
    if (nth > 1) return json({ jobs: [] });
    return json({
      jobs: [
        { id: 1, ...devops, title: devops.title, content: devops.description, absolute_url: `https://example.com/gh/${slug}`, location: { name: "Mumbai, India" }, updated_at: "2026-09-01T00:00:00.000Z" },
        { id: 1, title: "Site Reliability Engineer", content: "<p>Kubernetes</p>", absolute_url: `https://example.com/gh/${slug}`, location: { name: "Mumbai, India" }, updated_at: "", created_at: "nope" },
        { title: "Accountant", content: "payroll" },
      ],
    });
  }
  if (host === "api.lever.co") {
    if (nth === 2) return json({ nope: true });
    if (nth > 1) return json([]);
    return json([
      { id: "l1", text: "DevOps Engineer", description: "<b>Kubernetes</b> &lt;Terraform&gt;", categories: { location: "Remote, India" }, hostedUrl: `https://jobs.lever.co/${slug}/l1`, createdAt: 1_700_000_000_000 },
    ]);
  }
  if (host === "api.ashbyhq.com") {
    if (nth === 1) {
      return json({ jobs: [{ id: "a1", title: "DevOps Engineer", descriptionHtml: "Kubernetes&nbsp;Terraform", location: { locationName: "Mumbai, India" }, isRemote: true, publishedAt: "2026-09-01", jobUrl: `https://jobs.ashbyhq.com/${slug}/a1` }] });
    }
    if (nth === 2) {
      return json({ jobs: [{ title: "Platform Engineer", descriptionPlain: "Kubernetes and GCP for infrastructure", location: "Bengaluru, India", publishedDate: "2026-08-01", applyUrl: `https://jobs.ashbyhq.com/${slug}/a2` }] });
    }
    return json({ jobs: [] });
  }
  if (host.endsWith(".recruitee.com")) {
    if (nth > 1) return json({ offers: [] });
    return json({ offers: [{ id: 3, title: "DevOps Engineer", requirements: "Kubernetes &quot;Terraform&quot;", city: "Mumbai, India", remote: true, careers_url: `https://${host}/o/devops`, published_at: "2026-09-01T00:00:00.000Z" }] });
  }
  if (host === "api.smartrecruiters.com") {
    if (url.searchParams.get("offset") !== "0") return json({ totalFound: 1, content: [] });
    return json({
      totalFound: 2,
      content: [
        { name: "", location: { city: "Mumbai" } },
        { uuid: "s1", name: "DevOps Engineer", location: { fullLocation: "Mumbai, India", remote: true }, releasedDate: "2026-09-01" },
      ],
    });
  }
  if (host === "remotive.com") {
    return json({ jobs: [{ id: 9, title: "DevOps Engineer", company_name: "Remote Co", url: "https://remotive.com/job/9", candidate_required_location: "Worldwide", description: devops.description, publication_date: "2026-09-01", salary: "100k" }] });
  }
  if (host === "remoteok.com") {
    if (nth > 1) return json({ legal: true });
    return json([{ legal: true }, { id: "r1", position: "DevOps Engineer", company: "OK", url: "https://remoteok.com/r1", location: "India", description: "Kubernetes and Terraform", epoch: 1_700_000_000 }]);
  }
  if (host === "www.arbeitnow.com" || host === "arbeitnow.com") {
    return json({ data: [{ slug: "a", title: "DevOps Engineer", company_name: "Arbeit", url: "https://arbeitnow.com/a", location: "Berlin, Germany", description: "Kubernetes", created_at: "2026-09-01", remote: false }] });
  }
  if (host === "hn.algolia.com") {
    if (url.pathname.endsWith("/search")) return json({ hits: [{ objectID: "99" }] });
    const long = `DevOps Engineer\n${"kubernetes terraform remote ".repeat(8)}`;
    return json({ hits: [{ objectID: "1", comment_text: "short", created_at: "2026-09-01T00:00:00Z" }, { objectID: "2", comment_text: long, created_at: "not-a-date" }] });
  }
  if (host === "codeforces.com") {
    return json({
      status: "OK",
      result: [
        { blogEntry: { id: 5, title: "We are hiring a DevOps engineer", content: "<p>remote Kubernetes</p>" }, timeSeconds: 1_700_000_000 },
        { blogEntry: { id: 6, title: "Round announcement", content: "problems" } },
      ],
    });
  }
  if (host === "api.mycareersfuture.gov.sg") {
    return json({
      results: [
        { title: "DevOps Engineer", description: "Kubernetes in Singapore", uuid: "m1", postedCompany: { name: "SG Co" }, metadata: { jobDetailsUrl: "https://sg.example/m1", newPostingDate: "2026-09-01" }, address: { districts: [{ location: "Central" }] }, salary: { minimum: 5000, maximum: 8000 } },
        { title: "Accountant", description: "books" },
      ],
    });
  }
  return new Response(
    `<rss><item><title><![CDATA[Acme: DevOps Engineer]]></title><link>https://example.com/rss/${encodeURIComponent(host)}</link><description>Kubernetes and Terraform</description><pubDate>Mon, 01 Sep 2026 00:00:00 GMT</pubDate></item><item><title>Office manager</title><link>https://example.com/rss/${encodeURIComponent(host)}/office</link><description>Scheduling</description></item></rss>`,
    { headers: { "content-type": "application/xml" } },
  );
}

describe("crawling the public boards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("reads each board, skips a dead one, and reuses the list for half an hour", async () => {
    const seen = new Map<string, number>();
    const requests = stubFetch(({ url }) => boardResponse(url, seen));
    const { crawlPublicBoards, testPublicBoards } = await import("@/lib/job-search/board-crawl");

    const postings = await crawlPublicBoards("devops");
    const again = await crawlPublicBoards("something else");
    const vias = new Set(postings.map((item) => item.via.split(" · ")[0]));

    expect(again).toBe(postings);
    expect(requests.length).toBeGreaterThan(10);
    expect([...vias]).toEqual(expect.arrayContaining(["Greenhouse", "Lever", "Ashby", "Recruitee", "SmartRecruiters", "Remotive", "RemoteOK", "Arbeitnow", "HN Who is Hiring", "Codeforces", "MyCareersFuture (SG)", "We Work Remotely", "Berlin Startup Jobs"]));
    await expect(testPublicBoards()).resolves.toBeUndefined();
  });

  it("fails when every board fails, and still answers when only one does", async () => {
    stubFetch(() => json({}, { status: 503 }));
    const failing = await import("@/lib/job-search/board-crawl");
    await expect(failing.crawlPublicBoards("devops")).rejects.toThrow("Every public board failed");
    await expect(failing.testPublicBoards()).rejects.toThrow(/503/);

    vi.resetModules();
    const seen = new Map<string, number>();
    stubFetch(({ url }) => {
      if (url.hostname === "codeforces.com") return json({ status: "FAILED", comment: "nope" });
      if (url.hostname === "hn.algolia.com" && url.pathname.endsWith("/search")) return json({ hits: [] });
      if (url.hostname === "remoteok.com") return json({ legal: true });
      return boardResponse(url, seen);
    });
    const mixed = await import("@/lib/job-search/board-crawl");
    await expect(mixed.crawlPublicBoards("devops")).resolves.toEqual(expect.any(Array));
  });

  it("searches a page at a time and reports a board it cannot reach", async () => {
    const seen = new Map<string, number>();
    stubFetch(({ url }) => boardResponse(url, seen));
    const { publicBoards } = await import("@/lib/job-search/public-boards");
    const query = { ...EMPTY_QUERY, keywords: "devops", country: "in" };

    const first = await publicBoards.search(query, {}, null);
    expect(first.postings.length).toBeGreaterThan(0);
    expect(first.postings.length).toBeLessThanOrEqual(20);
    expect(first.postings.every((item) => item.source === "PUBLIC_BOARDS")).toBe(true);
    const second = await publicBoards.search(query, {}, first.next ?? "offset:abc");
    expect(second.postings.length).toBeGreaterThan(0);
    const withText = first.postings.find((item) => item.description);
    expect(withText?.description).toBeTruthy();
    if (!withText) return;
    expect(await publicBoards.details(withText)).toBe(withText.description);
    expect(await publicBoards.details({ ...withText, description: "" })).toBeNull();
    await expect(publicBoards.test({})).resolves.toBeUndefined();

    vi.resetModules();
    vi.stubGlobal("fetch", () => {
      throw "nope";
    });
    const broken = await import("@/lib/job-search/public-boards");
    await expect(broken.publicBoards.search(query, {}, null)).rejects.toMatchObject({ problem: "unavailable" });
    await expect(broken.publicBoards.test({})).rejects.toMatchObject({ problem: "unavailable", detail: expect.stringContaining("test failed") });
  });
});
