"use client";

import { useContext, useMemo } from "react";
import {
  PathnameContext,
  ReadonlyURLSearchParams,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

/**
 * Pathname and search params via router contexts (not `next/navigation`).
 * Prefer these over Next's hooks so client UI stays clear of Next 16.4's
 * Suspense DevTools `use(promise)` instrumentation; the yarn patch on `next`
 * covers the remaining App Router internals that tripped React 19.3's
 * conditional-use warning.
 */
export function usePathname(): string {
  return useContext(PathnameContext) ?? "";
}

export function useSearchParams(): ReadonlyURLSearchParams {
  const searchParams = useContext(SearchParamsContext);
  return useMemo(
    () => new ReadonlyURLSearchParams(searchParams ?? new URLSearchParams()),
    [searchParams],
  );
}
