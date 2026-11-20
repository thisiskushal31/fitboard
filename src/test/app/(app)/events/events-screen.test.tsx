import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/toast";
import { eventFilterSchema, type EventView } from "@/lib/events/types";

import { refreshEventsNow, removeEventForGood, setEventStatus } from "@/app/(app)/events/actions";
import { EventsScreen } from "@/app/(app)/events/events-screen";

const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router, usePathname: () => "/events" }));
vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: React.ReactNode } & React.ComponentProps<"a">) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-job", () => ({ useJob: () => null }));
vi.mock("@/components/toast", () => ({ toast: vi.fn(), toastResult: (result: { ok: boolean }) => result }));
vi.mock("@/app/(app)/events/actions", () => ({
  refreshEventsNow: vi.fn(async () => ({ ok: true, data: { jobId: "job-1" } })),
  setEventStatus: vi.fn(async ({ status }: { status: string }) => ({ ok: true, data: { status } })),
  removeEventForGood: vi.fn(async () => ({ ok: true, data: null })),
}));

const event = (change: Partial<EventView> = {}): EventView => ({
  id: "e1",
  source: "TECHCONF",
  externalId: "1",
  title: "Android Dev Summit Berlin",
  summary: "Kotlin and Android",
  url: "https://example.com/android",
  place: "Berlin, Germany",
  city: "Berlin",
  country: "de",
  remote: false,
  format: "IN_PERSON",
  startsAt: "2026-12-01T00:00:00.000Z",
  endsAt: "2026-12-02T00:00:00.000Z",
  ticketPrice: "Free",
  speakers: ["Ada"],
  attendance: 200,
  audience: "Engineers",
  score: 88,
  proximity: 0,
  reasons: ["In Berlin", "Covers Android"],
  status: "NEW",
  notes: "",
  ...change,
});

const filter = eventFilterSchema.parse({});
const lastRefresh = {
  at: "2026-11-19T10:00:00.000Z",
  added: 2,
  sources: [
    { source: "TECHCONF" as const, found: 1, error: null },
    { source: "TECHMEETUPS" as const, found: 0, error: "TechMeetups took too long to answer" },
    { source: "CONFSTECH" as const, found: 1, error: null },
    { source: "MEETUP" as const, found: 0, error: null },
    { source: "COMPANY" as const, found: 2, error: null },
  ],
};

beforeEach(() => vi.clearAllMocks());

describe("EventsScreen", () => {
  it("explains how to start before the first refresh", () => {
    render(
      <EventsScreen
        filter={filter}
        list={{ events: [], total: 0, counts: { NEW: 0, SAVED: 0, DISMISSED: 0 } }}
        lastRefresh={null}
        refreshJobId={null}
        city="Berlin"
        country="Germany"
        today="2026-11-19"
        timeZone="UTC"
      />,
    );
    expect(screen.getByRole("heading", { level: 1, name: "Events" })).toBeInTheDocument();
    expect(screen.getByText(/Press/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeInTheDocument();
  });

  it("lists events, shows source failures, and saves or removes one", async () => {
    const user = userEvent.setup();
    render(
      <EventsScreen
        filter={filter}
        list={{ events: [event()], total: 1, counts: { NEW: 1, SAVED: 0, DISMISSED: 0 } }}
        lastRefresh={lastRefresh}
        refreshJobId={null}
        city="Berlin"
        country="Germany"
        today="2026-11-19"
        timeZone="UTC"
      />,
    );

    expect(screen.getByText(/Last refreshed/)).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/TechMeetups took too long/);
    expect(screen.getByRole("navigation", { name: "Events views" })).toBeInTheDocument();
    expect(screen.getByRole("search", { name: "Filter events" })).toBeInTheDocument();

    const card = screen.getByRole("article", { name: "Android Dev Summit Berlin" });
    expect(within(card).getByText("Ada")).toBeInTheDocument();
    expect(within(card).getByRole("link", { name: "Open event" })).toHaveAttribute("href", "https://example.com/android");

    await user.click(within(card).getByRole("button", { name: "Save" }));
    expect(setEventStatus).toHaveBeenCalledWith({ id: "e1", status: "SAVED" });
    expect(toast).toHaveBeenCalledWith("Saved.", expect.objectContaining({ action: expect.any(Object) }));

    await user.click(within(card).getByRole("button", { name: "Remove for good" }));
    await user.click(screen.getByRole("button", { name: "Remove" }));
    expect(removeEventForGood).toHaveBeenCalledWith({ id: "e1" });

    await user.click(screen.getByRole("button", { name: "Refresh" }));
    expect(refreshEventsNow).toHaveBeenCalled();
  });

  it("says when filters leave the list empty", () => {
    render(
      <EventsScreen
        filter={eventFilterSchema.parse({ q: "rust" })}
        list={{ events: [], total: 0, counts: { NEW: 0, SAVED: 0, DISMISSED: 0 } }}
        lastRefresh={lastRefresh}
        refreshJobId={null}
        city="Berlin"
        country="Germany"
        today="2026-11-19"
        timeZone="UTC"
      />,
    );
    expect(screen.getByText("None match these filters. Try fewer.")).toBeInTheDocument();
  });

  it("shows the empty new list and truncated totals", async () => {
    const user = userEvent.setup();
    render(
      <EventsScreen
        filter={eventFilterSchema.parse({ sort: "soon" })}
        list={{ events: [event()], total: 5, counts: { NEW: 5, SAVED: 0, DISMISSED: 0 } }}
        lastRefresh={{ ...lastRefresh, sources: lastRefresh.sources.map((source) => ({ ...source, error: null })) }}
        refreshJobId={null}
        city="Berlin"
        country="Germany"
        today="2026-11-19"
        timeZone="UTC"
      />,
    );
    expect(screen.getByText(/The nearest 1 of 5/)).toBeInTheDocument();
    expect(screen.getByText(/soonest first/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Sort"), "match");
    expect(router.replace).toHaveBeenCalled();
  });
});
