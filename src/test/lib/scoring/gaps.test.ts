import { describe, expect, it } from "vitest";

import { assessGap } from "@/lib/scoring/gaps";

describe("skill-led gap read", () => {
  it("suits a generic software engineer title when the skills match", () => {
    const read = assessGap(
      {
        title: "Software Engineer",
        description: "We need Kubernetes, Terraform, Python, and AWS in production.",
        place: "Bengaluru, India",
        remote: false,
      },
      ["Kubernetes", "Terraform", "Python", "AWS"],
    );
    expect(read.fit).toBe("suited");
    expect(read.regions).toContain("India");
    expect(read.missing).toEqual([]);
  });

  it("keeps a gap instead of treating missing skills as resume lines", () => {
    const read = assessGap(
      {
        title: "Security Engineer",
        description: "SIEM, YARA, and detection engineering. MITRE ATT&CK mapping required.",
        place: "London, United Kingdom",
        remote: false,
      },
      ["Kubernetes"],
    );
    expect(read.fit).toBe("not_suited");
    expect(read.missing.length).toBeGreaterThan(0);
    expect(read.resumeNote.toLowerCase()).toContain("resume");
    expect(read.regions).toContain("UK");
  });
});
