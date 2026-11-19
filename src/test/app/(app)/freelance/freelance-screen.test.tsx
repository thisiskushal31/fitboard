import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import { freelanceFilterSchema, type FreelanceView } from "@/lib/freelance/types";

import { refreshFreelanceNow, removeFreelanceForGood, setFreelanceStatus } from "@/app/(app)/freelance/actions";
import { FreelanceScreen } from "@/app/(app)/freelance/freelance-screen";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/freelance" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode } & React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-job", () => ({ useJob: () => null }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: { ok: boolean }) => result }));
vi.mock("@/app/(app)/freelance/actions", () => ({
  refreshFreelanceNow: vi.fn(async () => ({ ok: true, data: { jobId: "job-1" } })),
  setFreelanceStatus: vi.fn(async ({ status }: { status: string }) => ({ ok: true, data: { status } })),
  removeFreelanceForGood: vi.fn(async () => ({ ok: true, data: null })),
}));

const gig = (change: Partial<FreelanceView> = {}): FreelanceView => ({
  id: "g1",
  source: "HN",
  externalId: "1",
  title: "Contract Android engineer",
  company: "Acme",
  place: "Berlin, Germany",
  remote: false,
  engagement: "CONTRACT",
  budget: "$80/hr",
  duration: "3 months",
  url: "https://example.com/gig",
  description: "Need Kotlin and Android.",
  postedAt: "2026-11-01T00:00:00.000Z",
  score: 90,
  reasons: ["Covers Android"],
  status: "NEW",
  notes: "",
  applicationId: null,
  ...change,
});

const filter = freelanceFilterSchema.parse({});
const lastRefresh = {
  at: "2026-11-19T10:00:00.000Z",
  added: 1,
  sources: [
    { source: "HN" as const, found: 1, error: null },
    { source: "REMOTIVE" as const, found: 0, error: "Remotive answered with an error (503)" },
    { source: "WWR" as const, found: 0, error: null },
    { source: "FREELANCER" as const, found: 0, error: null },
    { source: "REMOTEOK" as const, found: 0, error: null },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe("FreelanceScreen", () => {
  it("explains how to start before the first refresh", () => {
    render(
      <FreelanceScreen
        filter={filter}
        list={{ opportunities: [], total: 0, counts: { NEW: 0, SAVED: 0, CONTACTED: 0, DISMISSED: 0 } }}
        lastRefresh={null}
        refreshJobId={null}
        city="Berlin"
        country="Germany"
        aiReady
        today="2026-11-19"
        timeZone="UTC"
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Freelance" })).toBeInTheDocument();
    expect(screen.getByText(/Press/)).toBeInTheDocument();
  });

  it("lists gigs, shows source failures, and starts an application when AI is ready", async () => {
    const user = userEvent.setup();
    render(
      <FreelanceScreen
        filter={filter}
        list={{ opportunities: [gig()], total: 1, counts: { NEW: 1, SAVED: 0, CONTACTED: 0, DISMISSED: 0 } }}
        lastRefresh={lastRefresh}
        refreshJobId={null}
        city="Berlin"
        country="Germany"
        aiReady
        today="2026-11-19"
        timeZone="UTC"
      />,
    );

    expect(screen.getByText(/Last refreshed/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/Remotive answered/);
    const card = screen.getByRole("article", { name: "Contract Android engineer" });
    expect(within(card).getByRole("link", { name: "Start application" })).toHaveAttribute("href", "/new?freelance=g1");
    expect(within(card).getByRole("link", { name: "Open posting" })).toHaveAttribute("href", "https://example.com/gig");

    await user.click(within(card).getByRole("button", { name: "Dismiss" }));
    expect(setFreelanceStatus).toHaveBeenCalledWith({ id: "g1", status: "DISMISSED" });
    expect(toast).toHaveBeenCalledWith("Dismissed.", expect.objectContaining({ action: expect.any(Object) }));

    await user.click(within(card).getByRole("button", { name: "Remove for good" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeFreelanceForGood).toHaveBeenCalledWith({ id: "g1" });

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refreshFreelanceNow).toHaveBeenCalled();
  });

  it("points to AI settings when drafting is not ready", () => {
    render(
      <FreelanceScreen
        filter={filter}
        list={{ opportunities: [gig()], total: 1, counts: { NEW: 1, SAVED: 0, CONTACTED: 0, DISMISSED: 0 } }}
        lastRefresh={lastRefresh}
        refreshJobId={null}
        city="Berlin"
        country="Germany"
        aiReady={false}
        today="2026-11-19"
        timeZone="UTC"
      />,
    );
    expect(screen.getByRole("link", { name: "Set up AI to draft" })).toHaveAttribute("href", "/settings?section=ai");
  });

  it("opens an existing application and shows truncated newest totals", async () => {
    const user = userEvent.setup();
    render(
      <FreelanceScreen
        filter={freelanceFilterSchema.parse({ sort: "newest" })}
        list={{ opportunities: [gig({ applicationId: "app-1", status: "CONTACTED" })], total: 4, counts: { NEW: 0, SAVED: 0, CONTACTED: 4, DISMISSED: 0 } }}
        lastRefresh={{ ...lastRefresh, sources: lastRefresh.sources.map((source) => ({ ...source, error: null })) }}
        refreshJobId={null}
        city="Berlin"
        country="Germany"
        aiReady
        today="2026-11-19"
        timeZone="UTC"
      />,
    );
    expect(screen.getByText(/The best 1 of 4/)).toBeInTheDocument();
    expect(screen.getByText(/newest first/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the application" })).toHaveAttribute("href", "/applications/app-1");
    await user.selectOptions(screen.getByLabelText("Match"), "70");
    expect(router.replace).toHaveBeenCalled();
  });
});
