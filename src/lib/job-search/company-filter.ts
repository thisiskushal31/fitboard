/** Normalize an employer name for equality / contains checks. */
export function normalizeCompanyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether a posting's company field matches the selected employer:
 * exact match or either side contains the other after normalization.
 */
export function companyMatchesSelected(postingCompany: string, selected: string): boolean {
  const want = normalizeCompanyName(selected);
  if (!want) return true;
  const have = normalizeCompanyName(postingCompany);
  if (!have) return false;
  return have === want || have.includes(want) || want.includes(have);
}

/** Keep only postings whose company matches `selected` (no-op when empty). */
export function filterByCompany<T extends { company: string }>(postings: readonly T[], selected: string): T[] {
  if (!selected.trim()) return [...postings];
  return postings.filter((posting) => companyMatchesSelected(posting.company, selected));
}
