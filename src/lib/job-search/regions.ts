// Region tags and rank. Remote first, then India, then the rest of the map.
// A listing can carry more than one tag. The rank used for sorting is the
// best (highest) weight among the tags it has.

export const REGION_ORDER = [
  "Remote",
  "India",
  "Singapore",
  "UK",
  "Middle East",
  "Germany",
  "Nordics",
  "EMEA",
  "APAC",
  "US",
  "Americas",
] as const;

export type Region = (typeof REGION_ORDER)[number];

/** Choices in Find jobs → Country, besides a single country. */
export const ZONES = [
  { code: "remote", name: "Remote", area: "Remote" },
  { code: "apac", name: "APAC", area: "APAC" },
  { code: "emea", name: "EMEA", area: "EMEA" },
  { code: "mea", name: "MEA", area: "MEA" },
  { code: "americas", name: "Americas", area: "Americas" },
  { code: "nordics", name: "Nordics", area: "Nordics" },
] as const;

export type Zone = (typeof ZONES)[number];
export type ZoneArea = Zone["area"];

export function zoneByCode(code: string): Zone | undefined {
  return ZONES.find((zone) => zone.code === code);
}

/** The region a zone uses for a city match. MEA is the Middle East plus Africa. */
export function zoneRegion(zone: Zone): Region {
  return zone.area === "MEA" ? "Middle East" : zone.area;
}

export const LOCATION_WEIGHTS: Record<Region, number> = {
  Remote: 1,
  India: 0.98,
  Singapore: 0.94,
  UK: 0.9,
  "Middle East": 0.86,
  Germany: 0.82,
  Nordics: 0.78,
  EMEA: 0.76,
  APAC: 0.7,
  US: 0.5,
  Americas: 0.48,
};

const HINTS: Record<Region, readonly string[]> = {
  Remote: ["remote", "worldwide", "anywhere", "work from home", "wfh", "distributed"],
  India: ["india", "kolkata", "bengaluru", "bangalore", "hyderabad", "pune", "mumbai", "delhi", "noida", "gurgaon", "gurugram", "chennai", "ahmedabad", "jaipur"],
  Singapore: ["singapore", "marina bay", "jurong", "tampines", "raffles place"],
  UK: ["united kingdom", "london", "manchester", "edinburgh", "glasgow", "bristol", "cambridge", " uk", "uk ", "england", "scotland", "wales"],
  "Middle East": ["dubai", "abu dhabi", "uae", "united arab emirates", "qatar", "doha", "riyadh", "saudi", "bahrain", "kuwait", "muscat", "oman", "tel aviv", "israel"],
  Germany: ["germany", "berlin", "munich", "münchen", "hamburg", "frankfurt", "cologne", "köln", "stuttgart", "deutschland"],
  Nordics: ["sweden", "stockholm", "norway", "oslo", "denmark", "copenhagen", "finland", "helsinki", "iceland", "reykjavik", "nordics"],
  EMEA: ["europe", "emea", "netherlands", "amsterdam", "ireland", "dublin", "france", "paris", "spain", "madrid", "barcelona", "italy", "milan", "zurich", "switzerland", "poland", "warsaw", "austria", "vienna", "belgium", "brussels", "portugal", "lisbon"],
  APAC: ["apac", "asia pacific", "asia-pacific", "sydney", "melbourne", "australia", "tokyo", "japan", "osaka", "seoul", "korea", "hong kong", "jakarta", "indonesia", "bangkok", "thailand", "manila", "philippines", "kuala lumpur", "malaysia", "taipei", "taiwan", "vietnam", "ho chi minh", "hanoi", "auckland", "new zealand"],
  US: ["united states", "usa", "u.s.", "new york", "san francisco", "seattle", "austin", "boston", "chicago", "california", "texas", "remote us"],
  Americas: ["canada", "toronto", "vancouver", "montreal", "brazil", "são paulo", "sao paulo", "mexico", "mexico city", "argentina", "buenos aires", "latam", "latin america"],
};

const SHORT = new Set(["uk", "us", "uae"]);

const PLACE_NAMES: Record<string, readonly string[]> = {
  mumbai: ["mumbai", "bombay"],
  bombay: ["mumbai", "bombay"],
  bangalore: ["bangalore", "bengaluru"],
  bengaluru: ["bangalore", "bengaluru"],
  gurgaon: ["gurgaon", "gurugram"],
  gurugram: ["gurgaon", "gurugram"],
  delhi: ["delhi", "new delhi"],
  "new delhi": ["delhi", "new delhi"],
  kolkata: ["kolkata", "calcutta"],
  calcutta: ["kolkata", "calcutta"],
  chennai: ["chennai", "madras"],
  madras: ["chennai", "madras"],
};

/** Names to look for when the search says "Mumbai", including the older spelling. */
export function placeNames(place: string): string[] {
  const key = place.trim().toLowerCase();
  if (!key) return [];
  return [...(PLACE_NAMES[key] ?? [key])];
}

export function mentionsPlace(text: string, place: string): boolean {
  const names = placeNames(place);
  if (names.length === 0) return true;
  const blob = (text || "").toLowerCase();
  return names.some((name) => hit(blob, name));
}

const BROAD_REGIONS = new Set<Region>(["Remote", "EMEA", "APAC", "Americas"]);

/**
 * A city search also keeps a posting open across that country, such as
 * "India" or "Remote - India". A posting pinned to another city or country
 * does not qualify.
 */
export function openInCountry(placeText: string, city: string, region: Region | undefined): boolean {
  if (!region) return false;
  const where = placeText || "";
  if (pinnedToAnotherCity(where, city, region)) return false;
  if (!mentionsPlace(where, region)) return false;
  return detectRegions(where, null).every((name) => name === region || BROAD_REGIONS.has(name));
}

function pinnedToAnotherCity(text: string, city: string, region: Region): boolean {
  const own = new Set(placeNames(city));
  const country = region.toLowerCase();
  return HINTS[region].some((hint) => {
    const token = hint.trim().toLowerCase();
    if (!token || token === country || own.has(token)) return false;
    return mentionsPlace(text, token);
  });
}

const AFRICA = ["africa", "nigeria", "lagos", "kenya", "nairobi", "south africa", "johannesburg", "cape town", "egypt", "cairo", "morocco", "casablanca", "ghana", "accra", "ethiopia", "addis ababa"];

/**
 * A zone search. Remote keeps every remote role. APAC, EMEA, MEA, Americas
 * and Nordics keep a role in that part of the world, not a remote role that
 * never names it.
 */
export function matchesArea(text: string, remote: boolean | null, area: ZoneArea): boolean {
  const regions = detectRegions(text, remote);
  if (area === "Remote") return Boolean(remote) || regions.includes("Remote");
  if (area === "MEA") {
    if (regions.includes("Middle East")) return true;
    const blob = (text || "").toLowerCase();
    return AFRICA.some((hint) => hit(blob, hint));
  }
  if (regions.includes(area)) return true;
  if (area === "Americas" && regions.includes("US")) return true;
  return false;
}

/**
 * A country search keeps a job in that country. A remote job with no place
 * named is kept. A remote job limited to other countries is not.
 */
export function matchesCountry(text: string, remote: boolean | null, region: Region | undefined): boolean {
  if (!region) return true;
  const regions = detectRegions(text, remote);
  if (regions.includes(region)) return true;
  const remoteJob = Boolean(remote) || regions.includes("Remote");
  if (!remoteJob) return false;
  const blob = (text || "").toLowerCase();
  if (hit(blob, "worldwide") || hit(blob, "anywhere")) return true;
  return regions.every((name) => name === "Remote");
}

function hit(blob: string, needle: string): boolean {
  const token = needle.trim().toLowerCase();
  if (!token) return false;
  if (token.length <= 3 || SHORT.has(token) || needle.startsWith(" ") || needle.endsWith(" ")) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(blob);
  }
  return blob.includes(token);
}

/** ISO country code to the region a search in that country should keep. */
export const COUNTRY_REGION: Record<string, Region> = {
  in: "India",
  sg: "Singapore",
  gb: "UK",
  ae: "Middle East",
  sa: "Middle East",
  qa: "Middle East",
  bh: "Middle East",
  kw: "Middle East",
  om: "Middle East",
  il: "Middle East",
  de: "Germany",
  se: "Nordics",
  no: "Nordics",
  dk: "Nordics",
  fi: "Nordics",
  is: "Nordics",
  us: "US",
  ca: "Americas",
  br: "Americas",
  mx: "Americas",
  ar: "Americas",
  au: "APAC",
  nz: "APAC",
  jp: "APAC",
  kr: "APAC",
  hk: "APAC",
  id: "APAC",
  th: "APAC",
  ph: "APAC",
  my: "APAC",
  tw: "APAC",
  vn: "APAC",
  nl: "EMEA",
  ie: "EMEA",
  fr: "EMEA",
  es: "EMEA",
  it: "EMEA",
  ch: "EMEA",
  pl: "EMEA",
  at: "EMEA",
  be: "EMEA",
  pt: "EMEA",
};

export function detectRegions(text: string, remote: boolean | null = null): Region[] {
  const blob = (text || "").toLowerCase();
  const found: Region[] = [];
  if (remote || hit(blob, "remote") || hit(blob, "worldwide")) found.push("Remote");
  for (const name of REGION_ORDER) {
    if (name === "Remote") continue;
    if (HINTS[name].some((hint) => hit(blob, hint))) found.push(name);
  }
  const add = (name: Region) => {
    if (!found.includes(name)) found.push(name);
  };
  if (found.includes("UK") || found.includes("Germany") || found.includes("Nordics") || found.includes("Middle East")) add("EMEA");
  if (found.includes("Singapore") || found.includes("India")) add("APAC");
  return found;
}

/** Highest region weight. Remote is 1. Unknown text is 0. */
export function regionRank(regions: readonly Region[]): number {
  if (regions.length === 0) return 0;
  return Math.max(...regions.map((region) => LOCATION_WEIGHTS[region]));
}
