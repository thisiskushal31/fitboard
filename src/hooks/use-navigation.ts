"use client";

import { useContext, useMemo } from "react";
import {
  PathnameContext,
  ReadonlyURLSearchParams,
  SearchParamsContext,
} from "next/dist/shared/lib/hooks-client-context.shared-runtime";

/**
 * Pathname and search params without Next.js's Suspense DevTools `use()` path.
 * Next 16.4's `usePathname` / `useSearchParams` call `use(promise)` only when
 * NavigationPromisesContext is set, which trips React 19.3's conditional-use
 * warning in development. Reading the same contexts with `useContext` is enough
 * for highlighting and query updates.
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
