import { describe, expect, it } from "vitest";

import { settingsSectionFromParam, settingsSectionHref } from "@/app/(app)/settings/sections";

describe("settings sections", () => {
  it("reads the section from the URL, defaulting to AI provider", () => {
    expect(settingsSectionFromParam("data")).toBe("data");
    expect(settingsSectionFromParam(undefined)).toBe("ai");
    expect(settingsSectionFromParam("nope")).toBe("ai");
    expect(settingsSectionFromParam(["about", "data"])).toBe("ai");
    // "claude" selects the MCP connector.
    expect(settingsSectionFromParam("claude")).toBe("connector");
  });

  it("links to a section", () => {
    expect(settingsSectionHref("documents")).toBe("/settings?section=documents");
  });
});
