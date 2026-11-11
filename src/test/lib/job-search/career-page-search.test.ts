import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = vi.hoisted(() => ({ path: "" }));
vi.mock("@/lib/core/env", () => ({
  env: { get FITBOARD_DATA_DIR() { return dataDir.path; } },
}));
vi.mock("@/lib/job-search/crawl-results", () => ({
  recordBoardCrawl: async () => undefined,
}));
vi.mock("@/lib/ai", () => ({
  getAiProvider: async () => ({
    kind: "MOCK",
    model: "mock",
    complete: async (request: { messages?: { content?: string }[] }) => {
      const blob = request.messages?.[0]?.content || "";
      if (/devops/i.test(blob)) {
        return {
          relatedTitles: ["DevSecOps Engineer", "AWS Engineer – Infrastructure", "Site Reliability Engineer", "Platform Engineer"],
          relatedTerms: ["devsecops", "aws", "infrastructure", "sre", "platform", "cloud"],
        };
      }
      if (/salesforce/i.test(blob)) {
        return { relatedTitles: ["Salesforce Architect", "CRM Architect"], relatedTerms: ["salesforce", "sfdc", "crm"] };
      }
      if (/backend/i.test(blob)) {
        return { relatedTitles: ["Node.js Developer", "Java Backend Engineer", "API Engineer"], relatedTerms: ["backend", "node", "api"] };
      }
      return { relatedTitles: [], relatedTerms: [] };
    },
    listModels: async () => [],
    test: async () => ({ model: "mock", latencyMs: 1 }),
  }),
}));

const fake = vi.hoisted(() => ({
  html: "",
  pageUrl: "https://jobs.example.com/careers",
  filled: [] as string[],
  gotoStatus: 200 as number,
}));

vi.mock("playwright-core", () => {
  type Node = { tag: string; text: string; href?: string; name?: string; type?: string; placeholder?: string };

  function parseNodes(html: string): Node[] {
    const nodes: Node[] = [];
    const tagRe = /<(a|button|input)([^>]*)>([\s\S]*?)<\/\1>|<(input)([^>]*)\/?>/gi;
    let match: RegExpExecArray | null;
    while ((match = tagRe.exec(html))) {
      const tag = (match[1] || match[4] || "").toLowerCase();
      const attrs = match[2] || match[5] || "";
      const text = (match[3] || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      const attr = (name: string) => attrs.match(new RegExp(`${name}=["']([^"']*)["']`, "i"))?.[1];
      nodes.push({
        tag,
        text: text || attr("value") || attr("aria-label") || "",
        href: attr("href"),
        name: attr("name"),
        type: attr("type"),
        placeholder: attr("placeholder"),
      });
    }
    return nodes;
  }

  function makeLocator(selector: string) {
    const nodes = parseNodes(fake.html);
    const isLocationFilterSelect =
      /#job-locations|#jobs select|#all-jobs select|\.job-filter select|select\[id\*='location'|select\[name\*='location'/i.test(
        selector,
      );
    const isBrandFilterSelect =
      !isLocationFilterSelect &&
      /mob-select|#apply-now select|\.apply-job select|InCred|Finance.*Capital/i.test(selector);
    const isLocationSelector =
      !isLocationFilterSelect &&
      /name\*="(?:location|place|city)"|id\*="location"|placeholder\*="(?:location|city|remote|zip)"|aria-label\*="(?:location|city)"/i.test(
        selector,
      );
    const isSearchSelector =
      !isLocationSelector &&
      !isLocationFilterSelect &&
      (/type=["']search["']/i.test(selector) || /name\*="(?:search|query|keyword)"/i.test(selector) || /placeholder\*="(?:search|job|keyword|role)"/i.test(selector));
    const isSubmitSelector = /submit|Search|Find|Go/i.test(selector) && /button|input|role/i.test(selector);

    let matches: Node[] = [];
    if (isLocationFilterSelect) {
      matches =
        /id=["']job-locations["']|<select[^>]*(?:location|job-locations)/i.test(fake.html) ||
        /Find Your Gig/i.test(fake.html)
          ? [{ tag: "select", text: "All Locations" }]
          : [];
    } else if (isBrandFilterSelect) {
      matches = /mob-select|InCred Finance|apply-now/i.test(fake.html)
        ? [{ tag: "select", text: "InCred Finance" }]
        : [];
    } else if (isLocationSelector) {
      matches = nodes.filter((node) => node.tag === "input" && /location|place|city|zip|remote/i.test(`${node.name} ${node.placeholder}`));
    } else if (isSearchSelector) {
      matches = nodes.filter(
        (node) =>
          node.tag === "input" &&
          (node.type === "search" || /search|query|keyword|job|role/i.test(`${node.name} ${node.placeholder}`)),
      );
    } else if (isSubmitSelector) {
      matches = nodes.filter((node) => node.type === "submit" || /search|find|go/i.test(node.text));
    }

    const api = {
      count: async () => matches.length,
      first: () => api,
      nth: () => api,
      fill: async (value: string) => {
        if (isLocationSelector) fake.filled.push(`place:${value}`);
        else fake.filled.push(`search:${value}`);
      },
      click: async () => undefined,
      press: async () => undefined,
      pressSequentially: async (value: string) => {
        if (isLocationSelector) fake.filled.push(`place:${value}`);
        else fake.filled.push(`search:${value}`);
      },
      selectOption: async (value: string | { value?: string; label?: RegExp }) => {
        const label = typeof value === "string" ? value : value.value || "all";
        fake.filled.push(`locale:${label}`);
      },
      dispatchEvent: async () => undefined,
      evaluate: async (fn: (el: HTMLSelectElement, needle: string) => unknown, needle: string) => {
        const { JSDOM } = await import("jsdom");
        const dom = new JSDOM(fake.html, { url: fake.pageUrl });
        const el = dom.window.document.querySelector("select") as HTMLSelectElement | null;
        if (!el) return { value: "all" };
        return fn(el, needle);
      },
    };
    return api;
  }

  const page = {
    setDefaultTimeout: () => undefined,
    setDefaultNavigationTimeout: () => undefined,
    goto: async () => ({ status: () => fake.gotoStatus }),
    url: () => fake.pageUrl,
    frames: () => [],
    mainFrame: () => ({}),
    waitForSelector: async () => undefined,
    waitForLoadState: async () => undefined,
    locator: (selector: string) => makeLocator(selector),
    evaluate: async (fn: (base: string) => unknown, base: string) => {
      const { JSDOM } = await import("jsdom");
      const dom = new JSDOM(fake.html, { url: fake.pageUrl });
      const previous = globalThis.document;
      const previousWindow = globalThis.window;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).document = dom.window.document;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).window = dom.window;
      try {
        return fn(base);
      } finally {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).document = previous;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (globalThis as any).window = previousWindow;
      }
    },
  };

  return {
    chromium: {
      launch: async () => ({
        newContext: async () => ({
          newPage: async () => page,
          close: async () => undefined,
        }),
        on: () => undefined,
        close: async () => undefined,
      }),
    },
  };
});

describe("isJobHref", () => {
  it("keeps posting URLs and drops careers home and login links", async () => {
    const { isJobHref } = await import("@/lib/job-search/career-page-search");
    const base = "https://jobs.ericsson.com/careers";
    expect(isJobHref("https://jobs.ericsson.com/careers/job/563121777407955", base)).toBe(true);
    expect(isJobHref("https://jobs.example.com/jobs/devops-engineer", base)).toBe(true);
    expect(isJobHref("https://careers.dyson.com/en-gb/job-description/associate-principal-hardware-engineer/JR36848/", base)).toBe(true);
    expect(isJobHref("https://www.accenture.com/in-en/careers/jobdetails?id=ATCI-1_en&title=DevOps", base)).toBe(true);
    expect(isJobHref("https://intellious.tech/career/aws-engineer---infrastructure", base)).toBe(true);
    expect(isJobHref("https://jobs.example.com/careers", base)).toBe(false);
    expect(isJobHref("https://jobs.example.com/login", base)).toBe(false);
  });
});

describe("roleMatchesQuery", () => {
  it("matches compound role variants dynamically without hardcoded families", async () => {
    const { roleMatchesQuery, specialtyTokensRelated } = await import("@/lib/job-search/career-page-search");
    expect(specialtyTokensRelated("devops", "devsecops")).toBe(true);
    expect(specialtyTokensRelated("devops", "mlops")).toBe(false);
    expect(roleMatchesQuery("DevSecOps Engineer", "DevOps Engineer")).toBe(true);
    expect(roleMatchesQuery("Hands-On Salesforce Architect", "Salesforce")).toBe(true);
    expect(roleMatchesQuery("Oracle BRM PDC Developer", "DevOps Engineer")).toBe(false);
    // Broader cloud titles need AI-expanded related terms.
    expect(roleMatchesQuery("AWS Engineer – Infrastructure", "DevOps Engineer", "", ["aws", "infrastructure"])).toBe(true);
    expect(roleMatchesQuery("Oracle BRM PDC Developer", "DevOps Engineer", "", ["aws", "infrastructure"])).toBe(false);
  });
});

describe("expandRelatedRoleTerms", () => {
  it("uses AI to expand any role query into nearby titles/terms", async () => {
    const { expandRelatedRoleTerms, resetRelatedRoleCacheForTests } = await import("@/lib/job-search/related-roles");
    resetRelatedRoleCacheForTests();
    const devops = await expandRelatedRoleTerms("DevOps Engineer");
    expect(devops.some((term) => /devsecops|sre|platform|aws/i.test(term))).toBe(true);
    const backend = await expandRelatedRoleTerms("Backend Engineer");
    expect(backend.some((term) => /node|api|java/i.test(term))).toBe(true);
  });
});

describe("searchCareerPage", () => {
  beforeEach(async () => {
    dataDir.path = await mkdtemp(path.join(tmpdir(), "fitboard-career-"));
    fake.html = "";
    fake.filled = [];
    fake.gotoStatus = 200;
    fake.pageUrl = "https://jobs.example.com/careers";
    const { resetCareerSearchPoolForTests } = await import("@/lib/job-search/career-page-search");
    const { resetRelatedRoleCacheForTests } = await import("@/lib/job-search/related-roles");
    resetCareerSearchPoolForTests();
    resetRelatedRoleCacheForTests();
  });

  afterEach(async () => {
    await rm(dataDir.path, { recursive: true, force: true });
    vi.resetModules();
  });

  it("opens the given URL, types the search, and reads job cards", async () => {
    fake.html = `
      <form>
        <input type="search" name="query" />
        <input name="location" placeholder="City, state, zip code or 'remote'" />
        <button type="submit">Go</button>
      </form>
      <ul>
        <li class="job-card">
          <a href="/careers/job/563121777407955">DevOps Engineer</a>
          <span class="location">India</span>
        </li>
        <li class="job-card">
          <a href="/careers/job/999">Site Reliability Engineer</a>
          <span class="location">Stockholm</span>
        </li>
        <li><a href="/about">About us</a></li>
      </ul>
    `;
    const { searchCareerPage } = await import("@/lib/job-search/career-page-search");
    // Non-Phenom host so the browser path is exercised (Phenom uses a JSON API).
    const jobs = await searchCareerPage(
      { name: "Ericsson", url: "https://jobs.ericsson.com/careers" },
      { keywords: "DevOps Engineer", place: "Mumbai", country: "in" },
    );
    expect(fake.filled).toEqual(["search:DevOps Engineer", "place:Mumbai"]);
    expect(jobs.map((job) => [job.title, job.place, job.via])).toEqual([
      ["DevOps Engineer", "India", "Careers · Ericsson"],
      ["Site Reliability Engineer", "Stockholm", "Careers · Ericsson"],
    ]);
    expect(jobs[0].url).toContain("/careers/job/563121777407955");
  });

  it("reads Phenom JSON for portal.careers hosts without opening Chromium", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          positions: [
            {
              id: 563774612522102,
              name: "Assistant Director - Automation",
              location: "Bangalore, Karnataka, India",
              canonicalPositionUrl: "https://portal.careers.hsbc.com/careers/job/563774612522102",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { searchCareerPage } = await import("@/lib/job-search/career-page-search");
    const jobs = await searchCareerPage(
      { name: "HSBC", url: "https://portal.careers.hsbc.com/careers" },
      { keywords: "DevOps Engineer", place: "India", country: "in" },
    );
    expect(fetchMock).toHaveBeenCalled();
    expect(fake.filled).toEqual([]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      title: "Assistant Director - Automation",
      place: "Bangalore, Karnataka, India",
      company: "HSBC",
    });
    vi.unstubAllGlobals();
  });

  it("returns nothing when the given page has no search and no job links", async () => {
    fake.html = `<main><h1>Join our team</h1><p>We hire great people.</p><a href="/about">About us</a></main>`;
    const { searchCareerPage } = await import("@/lib/job-search/career-page-search");
    const jobs = await searchCareerPage(
      { name: "Acme", url: "https://acme.example/careers" },
      { keywords: "DevOps", place: "", country: "in" },
    );
    expect(jobs).toEqual([]);
    expect(fake.filled).toEqual([]);
  });

  it("reads location-filtered Find Your Gig listings without a keyword search", async () => {
    fake.pageUrl = "https://www.jiosaavn.com/corporate/careers";
    fake.html = `
      <div id="jobs">
        <h2>Find Your Gig.</h2>
        <div id="all-jobs">
          <div class="job-filter">
            <select id="job-locations">
              <option value="all">All Locations</option>
              <option value="mumbai">Mumbai, India</option>
              <option value="bengaluru">Bengaluru, India</option>
            </select>
          </div>
          <div class="nav-list job-group" data-department="engineering">
            <h4><span class="department">Engineering</span> <span class="openings">2 Openings</span></h4>
            <ul class="job-list">
              <li data-locale="mumbai">
                <a href="https://saavn.theresumator.com/apply/abc123">
                  <p class="title">Software Engineer – Full Stack</p>
                  <p class="type">Full Time</p>
                  <p class="locale">Mumbai, India</p>
                </a>
              </li>
              <li data-locale="bengaluru" style="display:none">
                <a href="https://saavn.theresumator.com/apply/hidden">
                  <p class="title">Hidden Role</p>
                  <p class="locale">Bengaluru, India</p>
                </a>
              </li>
              <li data-locale="mumbai">
                <a href="https://saavn.theresumator.com/apply/def456">
                  <p class="title">Data Analyst</p>
                  <p class="type">Full Time</p>
                  <p class="locale">Mumbai, India</p>
                </a>
              </li>
            </ul>
          </div>
        </div>
      </div>
    `;
    const { searchCareerPage } = await import("@/lib/job-search/career-page-search");
    const jobs = await searchCareerPage(
      { name: "JioSaavn", url: "https://www.jiosaavn.com/corporate/careers" },
      { keywords: "Software Engineer", place: "Mumbai", country: "in" },
    );
    // In-page match keeps the engineer role; Data Analyst is unrelated to the query.
    expect(jobs.map((job) => job.title)).toEqual(["Software Engineer – Full Stack"]);
    expect(jobs[0].place).toBe("Mumbai, India");
    expect(jobs[0].url).toContain("theresumator.com/apply/abc123");
    expect(jobs.some((job) => job.title === "Hidden Role")).toBe(false);
  });

  it("matches career cards in-page when there is no search box (Intellious-style)", async () => {
    fake.pageUrl = "https://intellious.tech/careers";
    fake.html = `
      <h2>Roles open right now</h2>
      <div class="career-item">
        <h3 fs-list-field="department" class="sub-title">Engineering</h3>
        <div class="career-card">
          <h4 class="sub-title">AWS Engineer – Infrastructure</h4>
          <div fs-list-field="location">Bangalore</div>
          <div class="country-name">India</div>
          <a href="/career/aws-engineer---infrastructure">Apply Now</a>
        </div>
        <div class="career-card">
          <h4 class="sub-title">Java Full Stack Developer – AWS</h4>
          <div fs-list-field="location">Delhi NCR</div>
          <div class="country-name">India</div>
          <a href="/career/java-full-stack-developer---aws">Apply Now</a>
        </div>
        <div class="career-card">
          <h4 class="sub-title">Oracle BRM Developer (Mid–Senior / Lead)</h4>
          <div fs-list-field="location">Bangalore</div>
          <a href="/career/oracle-brm-developer">Apply Now</a>
        </div>
      </div>
      <div class="career-item">
        <h3 class="sub-title">Marketing</h3>
        <div class="career-card">
          <h4 class="sub-title">Hands-On Salesforce Architect</h4>
          <div fs-list-field="location">Bengaluru</div>
          <a href="/career/hands-on-salesforce-architect">Apply Now</a>
        </div>
      </div>
    `;
    const { searchCareerPage } = await import("@/lib/job-search/career-page-search");
    const devops = await searchCareerPage(
      { name: "Intellious Technologies", url: "https://intellious.tech/careers" },
      { keywords: "DevOps Engineer", place: "Bangalore", country: "in" },
    );
    expect(devops.map((job) => job.title).sort()).toEqual([
      "AWS Engineer – Infrastructure",
      "Java Full Stack Developer – AWS",
    ]);
    expect(devops[0].url).toContain("/career/");

    // Fresh cache key via different keywords.
    const salesforce = await searchCareerPage(
      { name: "Intellious Technologies", url: "https://intellious.tech/careers" },
      { keywords: "Salesforce", place: "", country: "in" },
    );
    expect(salesforce.map((job) => job.title)).toEqual(["Hands-On Salesforce Architect"]);
  });

  it("sweeps InCred-style brand filters and soft-empties when every brand has no openings", async () => {
    fake.pageUrl = "https://incred.com/Career-Page/";
    fake.html = `
      <section id="apply-now" class="page4">
        <select class="mob-select">
          <option value="InCred Finance">InCred Finance</option>
          <option value="InCred Capital">InCred Capital</option>
          <option value="InCred Wealth">InCred Wealth</option>
          <option value="InCred Money">InCred Money</option>
        </select>
        <div class="apply-job">
          <div class="company-d">
            <div class="dropdown-box"><div class="dropdown"><p>No Current Opening</p></div></div>
          </div>
        </div>
      </section>
    `;
    const { searchCareerPage } = await import("@/lib/job-search/career-page-search");
    const jobs = await searchCareerPage(
      { name: "InCred", url: "https://incred.com/Career-Page/" },
      { keywords: "DevOps Engineer", place: "", country: "in" },
    );
    expect(jobs).toEqual([]);
  });

  it("collects openings across InCred-style brand filter options", async () => {
    fake.pageUrl = "https://incred.com/Career-Page/";
    fake.html = `
      <section id="apply-now">
        <select class="mob-select">
          <option value="InCred Finance">InCred Finance</option>
          <option value="InCred Capital">InCred Capital</option>
        </select>
        <div class="apply-job">
          <div class="dropdown-box">
            <div class="dropdown">
              <a href="/careers/aws-platform-engineer"><h4>AWS Platform Engineer</h4></a>
              <a href="/careers/devops-engineer"><h4>DevOps Engineer</h4></a>
            </div>
          </div>
        </div>
      </section>
    `;
    const { searchCareerPage } = await import("@/lib/job-search/career-page-search");
    const jobs = await searchCareerPage(
      { name: "InCred", url: "https://incred.com/Career-Page/" },
      { keywords: "DevOps Engineer", place: "", country: "in" },
    );
    expect(jobs.map((job) => job.title).sort()).toEqual(["AWS Platform Engineer", "DevOps Engineer"]);
  });

  it("soft-empties location-filter pages that currently have zero openings", async () => {
    fake.pageUrl = "https://www.jiosaavn.com/corporate/careers";
    fake.html = `
      <div id="jobs">
        <h2>Find Your Gig.</h2>
        <div id="all-jobs" class="card">
          <div class="job-filter">
            <select id="job-locations">
              <option value="all">All Locations</option>
              <option value="mumbai">Mumbai, India</option>
            </select>
          </div>
        </div>
      </div>
      <a class="locale-btn disabled" data-locale="mumbai"><strong>0 Openings</strong></a>
    `;
    const { searchCareerPage } = await import("@/lib/job-search/career-page-search");
    const jobs = await searchCareerPage(
      { name: "JioSaavn", url: "https://www.jiosaavn.com/corporate/careers" },
      { keywords: "Engineer", place: "", country: "in" },
    );
    expect(jobs).toEqual([]);
  });

  it("reads early-careers programme carousel cards when there is no search field", async () => {
    // careers.* hosts try Phenom first; force a miss so the browser path runs.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not found", { status: 404 })));
    fake.pageUrl = "https://careers.jaguarlandrover.com/early-careers";
    fake.html = `
      <section class="programme_slider_tabbed">
        <h2>PROGRAMMES</h2>
        <div class="programme-tabs">
          <a class="active" href="#">Apprenticeship</a>
          <a href="#">Undergraduate</a>
          <a href="#">Graduate</a>
        </div>
        <div class="tab-pane active" id="apprenticeship">
          <div class="slick-initialized slick-slider">
            <button class="slick-next" type="button">Next</button>
            <div class="programme-card slick-slide slick-active">
              <h3 class="programme-name">Level 6 Digital and Technology Solutions Degree Apprenticeship</h3>
              <div class="programme-info">Duration: 4 years Applications open: February 2027 Find out more</div>
              <a href="/early-careers/apprentices/level-6-digital-technology-solutions-degree-apprenticeship">Find out more</a>
            </div>
            <div class="programme-card slick-slide slick-cloned">
              <h3 class="programme-name">Cloned Duplicate</h3>
              <a href="/early-careers/apprentices/cloned">Find out more</a>
            </div>
          </div>
        </div>
        <div class="tab-pane" id="undergraduate">
          <div class="programme-card slick-slide">
            <h3 class="programme-name">Engineering Undergraduate</h3>
            <div class="programme-info">Duration: 12 months Find out more</div>
            <a href="/early-careers/undergraduates/undergraduate-engineering">Find out more</a>
          </div>
        </div>
        <div class="tab-pane" id="graduate">
          <div class="programme-card slick-slide">
            <h3 class="programme-name">Engineering Graduate</h3>
            <div class="programme-info">Duration: 2 years Find out more</div>
            <a href="/early-careers/graduates/graduate-engineering">Find out more</a>
          </div>
        </div>
      </section>
    `;
    const { searchCareerPage } = await import("@/lib/job-search/career-page-search");
    const jobs = await searchCareerPage(
      { name: "Jaguar Land Rover", url: "https://careers.jaguarlandrover.com/early-careers" },
      { keywords: "Engineering", place: "", country: "gb" },
    );
    expect(fake.filled).toEqual([]);
    // Ctrl+F / skill match keeps titles that mention Engineering.
    expect(jobs.map((job) => job.title)).toEqual([
      "Engineering Undergraduate",
      "Engineering Graduate",
    ]);
    expect(jobs[0].url).toContain("/early-careers/undergraduates/undergraduate-engineering");
    expect(jobs[0].place).toMatch(/undergraduate/i);
    vi.unstubAllGlobals();
  });

  it("reads Dyson-style /job-description/ cards and strips More details titles", async () => {
    fake.pageUrl = "https://careers.dyson.com/en-gb/search-results/";
    fake.html = `
      <input placeholder="Job title or keywords" name="keywords" />
      <button type="submit">Search jobs</button>
      <ul>
        <li>
          <h2>Software Engineer</h2>
          <a href="/en-gb/job-description/software-engineer/JR1/">More details about Software Engineer</a>
        </li>
      </ul>
    `;
    const { searchCareerPage } = await import("@/lib/job-search/career-page-search");
    const jobs = await searchCareerPage(
      { name: "Dyson", url: "https://careers.dyson.com/en-gb/search-results/" },
      { keywords: "Software Engineer", place: "", country: "in" },
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ title: "Software Engineer", company: "Dyson" });
    expect(jobs[0].url).toContain("/job-description/software-engineer/");
  });

  it("reuses the disk cache within half an hour", async () => {
    fake.html = `
      <input type="search" name="query" />
      <a href="/jobs/devops-lead">DevOps Lead</a>
    `;
    const { searchCareerPage } = await import("@/lib/job-search/career-page-search");
    const company = { name: "Acme", url: "https://acme.example/careers" };
    const query = { keywords: "DevOps", place: "", country: "" };
    const first = await searchCareerPage(company, query);
    expect(first).toHaveLength(1);
    fake.html = `<main>changed</main>`;
    fake.filled = [];
    const second = await searchCareerPage(company, query);
    expect(second).toEqual(first);
    expect(fake.filled).toEqual([]);
  });
});
