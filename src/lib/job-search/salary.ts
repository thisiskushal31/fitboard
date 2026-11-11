/**
 * Parse and compare posting salaries. Pure helpers — no network, no DB.
 */

export type SalaryPeriod = "year" | "month" | "hour" | "day" | "week";

export type ParsedSalary = {
  min: number;
  max: number;
  mid: number;
  currency: string;
  period: SalaryPeriod;
  /** As shown to the user, e.g. "USD 80,000–120,000 a year". */
  label: string;
};

export type PayCompareRow = {
  company: string;
  mid: number | null;
  label: string;
  currency: string | null;
  postingCount: number;
  /** True when no numeric salary was found for this company. */
  unknown: boolean;
};

const CURRENCY_SYMBOLS: Record<string, string> = {
  $: "USD",
  "€": "EUR",
  "£": "GBP",
  "₹": "INR",
  "¥": "JPY",
  "₩": "KRW",
  "₪": "ILS",
  A$: "AUD",
  C$: "CAD",
  S$: "SGD",
  NZ$: "NZD",
  R$: "BRL",
  CHF: "CHF",
  EUR: "EUR",
  USD: "USD",
  GBP: "GBP",
  INR: "INR",
  AUD: "AUD",
  CAD: "CAD",
  SGD: "SGD",
  NZD: "NZD",
  PLN: "PLN",
  ZAR: "ZAR",
  BRL: "BRL",
  MXN: "MXN",
};

const CURRENCY_TOKEN =
  "(?:(?:USD|EUR|GBP|INR|AUD|CAD|SGD|NZD|PLN|ZAR|CHF|BRL|MXN|JPY|KRW)|A\\$|C\\$|S\\$|NZ\\$|R\\$|[€£$₹¥₩])";

function amount(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function periodLabel(period: SalaryPeriod): string {
  if (period === "year") return "a year";
  if (period === "month") return "a month";
  if (period === "hour") return "an hour";
  if (period === "day") return "a day";
  return "a week";
}

export function formatSalaryRange(min: number, max: number, currency: string, period: SalaryPeriod = "year"): string {
  const range = Math.round(min) === Math.round(max) ? amount(min) : `${amount(min)}–${amount(max)}`;
  return [currency, range, periodLabel(period)].filter(Boolean).join(" ");
}

function parseNumberToken(raw: string): number | null {
  const cleaned = raw.replace(/,/g, "").trim();
  const match = cleaned.match(/^([\d.]+)\s*([kKmMbB])?$/);
  if (!match) return null;
  let value = Number(match[1]);
  if (!Number.isFinite(value) || value <= 0) return null;
  const suffix = (match[2] || "").toLowerCase();
  if (suffix === "k") value *= 1_000;
  if (suffix === "m") value *= 1_000_000;
  if (suffix === "b") value *= 1_000_000_000;
  return value;
}

/** Period words next to the amount — not somewhere else in a long description. */
function detectPeriodNear(snippet: string): SalaryPeriod {
  const text = snippet.toLowerCase();
  if (/\b(hour|hr|hourly|\/hr|per hour)\b/.test(text)) return "hour";
  if (/\b(day|daily|\/day|per day)\b/.test(text)) return "day";
  if (/\b(week|weekly|\/wk|per week)\b/.test(text)) return "week";
  if (/\b(month|monthly|\/mo|per month|pm)\b/.test(text)) return "month";
  if (/\b(lpa|lakh|lakhs|lac|lacs|ctc|p\.?\s*a\.?|per annum|\/yr|a year|annually)\b/.test(text)) return "year";
  return "year";
}

function detectCurrency(blob: string): string {
  const upper = blob.toUpperCase();
  for (const code of ["USD", "EUR", "GBP", "INR", "AUD", "CAD", "SGD", "NZD", "PLN", "ZAR", "CHF", "BRL", "MXN", "JPY", "KRW"]) {
    if (new RegExp(`\\b${code}\\b`).test(upper)) return code;
  }
  if (/A\$/.test(blob)) return "AUD";
  if (/C\$/.test(blob)) return "CAD";
  if (/S\$/.test(blob)) return "SGD";
  if (/NZ\$/.test(blob)) return "NZD";
  if (/R\$/.test(blob)) return "BRL";
  if (/€/.test(blob)) return "EUR";
  if (/£/.test(blob)) return "GBP";
  if (/₹/.test(blob)) return "INR";
  if (/¥/.test(blob)) return "JPY";
  if (/₩/.test(blob)) return "KRW";
  if (/\$/.test(blob)) return "USD";
  return "";
}

function looksLikeExperience(before: string, after: string): boolean {
  const left = before.toLowerCase();
  const right = after.toLowerCase();
  // "Exp : 3-12 yrs", "3–12 years of experience", "experience: 3 to 12 years"
  if (/\b(exp\.?|experience|experienced?)\b/.test(left.slice(-40))) return true;
  if (/^\s*(yrs?|years?)\b/.test(right)) return true;
  if (/^\s*(to\s+)?\d+\s*(yrs?|years?)\b/.test(right)) return true;
  if (/^\s*(yrs?|years?)\s+(of\s+)?(exp|experience)\b/.test(right)) return true;
  return false;
}

function isLakhUnit(after: string): boolean {
  return /^\s*(lpa|lakh|lakhs|lac|lacs|lacs?\s*p\.?\s*a\.?)\b/i.test(after);
}

function hasPayCue(before: string, match: string, after: string): boolean {
  const around = `${before.slice(-30)}${match}${after.slice(0, 30)}`.toLowerCase();
  if (new RegExp(CURRENCY_TOKEN, "i").test(around)) return true;
  if (/\b(lpa|lakh|lakhs|lac|lacs|ctc|salary|compensation|package|remuneration|pay|wage|stipend)\b/i.test(around)) return true;
  if (/\d\s*[kKmMbB]\b/.test(match)) return true;
  return false;
}

function plausiblePay(min: number, max: number, period: SalaryPeriod, lakh: boolean): boolean {
  if (lakh) return min >= 1 && max <= 500;
  // Tiny bare integers as "a year" are almost never real annual pay.
  if (period === "year" && max < 1_000) return false;
  if (period === "month" && max < 100) return false;
  if (period === "day" && (min < 20 || max > 50_000)) return false;
  if (period === "hour" && (min < 5 || max > 2_000)) return false;
  return true;
}

type Candidate = {
  index: number;
  min: number;
  max: number;
  currency: string;
  period: SalaryPeriod;
};

/**
 * Pull a salary range from free text (posting.salary or description).
 * Returns null when nothing numeric is found — and ignores experience bands
 * like "Exp : 3-12 yrs" that are not pay.
 */
export function parseSalaryText(text: string, fallbackCurrency = ""): ParsedSalary | null {
  const blob = text.replace(/\u00a0/g, " ").trim();
  if (!blob) return null;

  const fallback = fallbackCurrency.trim().toUpperCase();
  const rangeRe = new RegExp(
    `(${CURRENCY_TOKEN})?\\s*([\\d.,]+\\s*[kKmMbB]?)\\s*(?:-|–|—|to)\\s*(${CURRENCY_TOKEN})?\\s*([\\d.,]+\\s*[kKmMbB]?)`,
    "gi",
  );

  let best: Candidate | null = null;
  for (const match of blob.matchAll(rangeRe)) {
    const full = match[0];
    const index = match.index ?? 0;
    const before = blob.slice(Math.max(0, index - 48), index);
    const after = blob.slice(index + full.length, index + full.length + 48);
    if (looksLikeExperience(before, after)) continue;

    const leftCur = match[1] ? detectCurrency(match[1]) : "";
    const rightCur = match[3] ? detectCurrency(match[3]) : "";
    let min = parseNumberToken(match[2]);
    let max = parseNumberToken(match[4]);
    if (!min || !max) continue;

    const lakh = isLakhUnit(after);
    if (!lakh && !hasPayCue(before, full, after)) continue;

    const snippet = `${before.slice(-24)}${full}${after.slice(0, 24)}`;
    const period = detectPeriodNear(snippet);
    if (!plausiblePay(min, max, period, lakh)) continue;

    if (lakh) {
      min *= 100_000;
      max *= 100_000;
    }

    const low = Math.min(min, max);
    const high = Math.max(min, max);
    const currency = leftCur || rightCur || detectCurrency(snippet) || (lakh ? "INR" : "") || fallback || "USD";
    const candidate: Candidate = { index, min: low, max: high, currency, period: lakh ? "year" : period };
    // Prefer earlier matches that look like a dedicated salary line.
    if (!best || index < best.index) best = candidate;
  }

  if (best) {
    return {
      min: best.min,
      max: best.max,
      mid: (best.min + best.max) / 2,
      currency: best.currency,
      period: best.period,
      label: formatSalaryRange(best.min, best.max, best.currency, best.period),
    };
  }

  // Single amount: "USD 120000 a year", "$90k", "18 LPA"
  const singleRe = new RegExp(`(?:${CURRENCY_TOKEN})\\s*([\\d.,]+\\s*[kKmMbB]?)|\\b([\\d.,]+\\s*[kK])\\b|\\b([\\d.,]+)\\s*(lpa|lakh|lakhs|lac|lacs)\\b`, "gi");
  for (const match of blob.matchAll(singleRe)) {
    const full = match[0];
    const index = match.index ?? 0;
    const before = blob.slice(Math.max(0, index - 48), index);
    const after = blob.slice(index + full.length, index + full.length + 48);
    if (looksLikeExperience(before, after)) continue;

    const lakh = Boolean(match[4]) || isLakhUnit(after);
    const raw = match[1] || match[2] || match[3];
    let value = parseNumberToken(raw ?? "");
    if (!value) continue;

    const snippet = `${before.slice(-24)}${full}${after.slice(0, 24)}`;
    if (!lakh && !hasPayCue(before, full, after) && !match[1]) continue;

    const period = lakh ? "year" : detectPeriodNear(snippet);
    if (!plausiblePay(value, value, period, lakh)) continue;
    if (lakh) value *= 100_000;

    const currency = detectCurrency(snippet) || (lakh ? "INR" : "") || fallback || "USD";
    return {
      min: value,
      max: value,
      mid: value,
      currency,
      period,
      label: formatSalaryRange(value, value, currency, period),
    };
  }

  return null;
}

/** Offer salary from the structured field, else a parse of title + description. */
export function offerSalaryOf(posting: { salary?: string; title?: string; description?: string }, fallbackCurrency = ""): ParsedSalary | null {
  const fromField = parseSalaryText(posting.salary ?? "", fallbackCurrency);
  if (fromField) return fromField;
  return parseSalaryText(`${posting.title ?? ""}\n${(posting.description ?? "").slice(0, 4_000)}`, fallbackCurrency);
}

/**
 * Rank companies in the current result set by mid salary (high → low).
 * Companies without a numeric salary sort last as unknown.
 */
export function buildPayCompare(
  postings: readonly { company: string; salary?: string; title?: string; description?: string }[],
): PayCompareRow[] {
  const byCompany = new Map<string, { mids: number[]; labels: string[]; currency: string | null; count: number }>();
  for (const posting of postings) {
    const company = posting.company.trim() || "Unknown company";
    const parsed = offerSalaryOf(posting);
    const entry = byCompany.get(company) ?? { mids: [], labels: [], currency: null, count: 0 };
    entry.count += 1;
    if (parsed) {
      entry.mids.push(parsed.mid);
      entry.labels.push(parsed.label);
      entry.currency = parsed.currency;
    }
    byCompany.set(company, entry);
  }

  const rows: PayCompareRow[] = [];
  for (const [company, entry] of byCompany) {
    if (entry.mids.length === 0) {
      rows.push({ company, mid: null, label: "Salary not listed", currency: null, postingCount: entry.count, unknown: true });
      continue;
    }
    const mid = entry.mids.reduce((sum, value) => sum + value, 0) / entry.mids.length;
    const currency = entry.currency ?? "USD";
    rows.push({
      company,
      mid,
      label: formatSalaryRange(mid, mid, currency),
      currency,
      postingCount: entry.count,
      unknown: false,
    });
  }

  return rows.sort((a, b) => {
    if (a.unknown !== b.unknown) return a.unknown ? 1 : -1;
    return (b.mid ?? 0) - (a.mid ?? 0) || a.company.localeCompare(b.company);
  });
}

/** Re-export for callers that map country → ISO currency. */
export const salaryCurrencySymbols = CURRENCY_SYMBOLS;
