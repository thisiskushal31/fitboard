import { describe, expect, it } from "vitest";

import { filterPublicBoards, officialCareers, type CrawledPosting } from "@/lib/job-search/board-crawl";

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
});
