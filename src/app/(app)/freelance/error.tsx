"use client";

import { ScreenError, type ErrorPageProps } from "@/components/screen-error";

export default function FreelanceError(props: ErrorPageProps) {
  return <ScreenError {...props} title="Freelance didn't load" />;
}
