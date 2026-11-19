"use client";

import { ScreenError, type ErrorPageProps } from "@/components/screen-error";

export default function EventsError(props: ErrorPageProps) {
  return <ScreenError {...props} title="Events didn't load" />;
}
