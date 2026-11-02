import { redirect } from "next/navigation";
import { describe, expect, it, vi } from "vitest";

import { signOut } from "@/lib/auth/actions";
import { endSession } from "@/lib/auth/session";

vi.mock("@/lib/auth/session", () => ({ endSession: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

describe("signOut", () => {
  it("deletes the session cookie and goes to the sign-in page", async () => {
    await signOut();
    expect(endSession).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledWith("/login");
  });
});
