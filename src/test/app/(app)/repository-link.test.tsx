import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RepositoryLink } from "@/app/(app)/repository-link";
import { SidebarFrame } from "@/app/(app)/sidebar-frame";

afterEach(() => {
  document.cookie = "fitboard_sidebar=; max-age=0; path=/";
});

function renderLink(initialCollapsed = false) {
  render(
    <SidebarFrame initialCollapsed={initialCollapsed} brand={<span>Fitboard</span>}>
      <RepositoryLink />
    </SidebarFrame>,
  );
  return screen.getByRole("link", { name: "Star on GitHub (opens in a new tab)" });
}

describe("RepositoryLink", () => {
  it("opens the repository in a new tab", () => {
    const link = renderLink();
    expect(link).toHaveAttribute("href", "https://github.com/thisiskushal31/fitboard");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(link).not.toHaveAttribute("title");
  });

  it("keeps its name and gets a tooltip while the sidebar is collapsed", () => {
    expect(renderLink(true)).toHaveAttribute("title", "Star on GitHub");
  });
});
