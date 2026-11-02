"use client";

import { ScreenError, type ErrorPageProps } from "@/components/screen-error";

/** When a screen in the app fails to load; the sidebar stays. */
export default function AppError(props: ErrorPageProps) {
  return <ScreenError {...props} title="This screen didn't load" elsewhere={{ href: "/applications", label: "Open your applications" }} />;
}
