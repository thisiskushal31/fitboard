"use server";

import { redirect } from "next/navigation";

import { endSession } from "./session";

/** Clears the session from the sidebar, then opens the sign-in page. */
export async function signOut(): Promise<void> {
  await endSession();
  redirect("/login");
}
