// Company-independent career path. Role names are edited in the app.
// Each one is scored from the live crawl: skills those listings asked for
// that the profile still lacks. Listings are signals, not an employer promise.

import { assessGap } from "@/lib/scoring/gaps";

export type CareerKind = "current" | "next" | "destination" | "trending";

export type CareerRoles = {
  current: string[];
  next: string[];
  destination: string[];
  trending: string[];
};

export const EMPTY_CAREER_ROLES: CareerRoles = { current: [], next: [], destination: [], trending: [] };

export type RoleReport = {
  name: string;
  kind: CareerKind;
  layers: string[];
  listingCount: number;
  closeness: string;
  nextMove: string;
  have: string[];
  lacking: string[];
};

export type CareerReport = {
  roles: RoleReport[];
  /** Skills the whole crawl asked for that the profile lacks, most mentioned first. */
  checks: { skill: string; mentions: number }[];
};

type CatalogRow = { layers: string[]; watch: string[]; next: string };

const CATALOG: Record<string, CatalogRow> = {
  "devops engineer": {
    layers: ["platform"],
    watch: ["kubernetes", "terraform", "gitops", "ci/cd", "aws", "gcp", "ansible", "prometheus", "iam", "python"],
    next: "Keep this hot. Do not abandon it while you add software, AI, and security proofs.",
  },
  "platform engineer": {
    layers: ["platform", "software"],
    watch: ["kubernetes", "gitops", "terraform", "internal developer platform", "backstage", "crossplane", "golden path", "multi-tenant", "iam", "observability"],
    next: "Treat identity and multi-tenant isolation as product, not as cluster YAML.",
  },
  "mlops engineer": {
    layers: ["ai", "platform"],
    watch: ["mlflow", "vertex ai", "sagemaker", "kubeflow", "feature store", "model registry", "gpu", "vllm", "ray", "airflow"],
    next: "One eval set and one serving SLO. Not another GPU node pool.",
  },
  "ai engineer": {
    layers: ["ai", "software"],
    watch: ["rag", "llm", "langchain", "embeddings", "vector", "eval", "agent", "mcp", "prompt", "qdrant"],
    next: "RAG over your own notes with a measured eval set, then a tool-calling agent with traces.",
  },
  "software engineer": {
    layers: ["software"],
    watch: ["python", "go", "java", "typescript", "testing", "api", "fastapi", "distributed systems"],
    next: "Ship one multi-tenant API with tests, auth, and traces — not another Terraform module.",
  },
  "forward-deployed engineer": {
    layers: ["software", "platform"],
    watch: ["python", "go", "kubernetes", "customer", "integration", "api", "embeddings", "llm"],
    next: "Keep this in line: sit with a real user problem and ship the integration yourself.",
  },
  "threat intelligence": {
    layers: ["security"],
    watch: ["mitre", "att&ck", "detection", "siem", "yara", "sigma", "threat intel", "ioc", "guardduty"],
    next: "ATT&CK mapped to GCP/AWS logs, three detections, one written brief.",
  },
  "security engineering": {
    layers: ["security", "platform"],
    watch: ["zero trust", "iam", "detection", "siem", "vault", "sast", "dast", "owasp", "incident response"],
    next: "Enter through cloud detection from the Zero Trust work you already shipped. Not Kali-first.",
  },
  "cloud engineer": {
    layers: ["platform"],
    watch: ["aws", "gcp", "azure", "terraform", "kubernetes", "iam", "vpc", "networking"],
    next: "Same jobs you already do. Keep cost and identity as first-class design.",
  },
  "site reliability engineer": {
    layers: ["platform"],
    watch: ["slo", "prometheus", "on-call", "kubernetes", "error budget", "observability"],
    next: "Write SLOs for something you already run. That is the SRE proof.",
  },
};

const LAYER_HINTS: Record<string, readonly string[]> = {
  software: ["software", "sde", "swe", "backend", "full stack", "forward-deployed", "forward deployed"],
  platform: ["platform", "devops", "sre", "cloud", "infrastructure", "reliability", "mlops"],
  ai: ["mlops", "machine learning", "llm", "ai engineer"],
  security: ["security", "cyber", "threat", "detection", "appsec", "devsecops"],
};

function catalogFor(name: string): CatalogRow {
  const key = name.trim().toLowerCase();
  return (
    CATALOG[key] ?? {
      layers: ["software"],
      watch: ["kubernetes", "terraform", "python", "aws", "gcp", "iam"],
      next: "Boards will say which skills this title is asking for. Learn those. Do not invent them on the resume.",
    }
  );
}

function mentions(blob: string, skill: string): boolean {
  return blob.includes(skill.toLowerCase());
}

function roleListings(postings: { title: string; description: string }[], name: string, layers: string[]) {
  const token = name.trim().toLowerCase();
  const hints = new Set<string>([token, ...layers.flatMap((layer) => [...(LAYER_HINTS[layer] ?? [])])]);
  return postings.filter((posting) => {
    const blob = `${posting.title} ${posting.description}`.toLowerCase();
    return [...hints].some((hint) => hint.length > 2 && blob.includes(hint));
  });
}

function closeness(have: number, lacking: number, listingCount: number): string {
  if (listingCount === 0) return "This crawl is not asking for this title.";
  if (lacking === 0) return "Boards in this crawl are not asking for skills you lack on this track.";
  if (have >= lacking) return "Close. The gaps below are what to learn, not what to write on the resume.";
  return "A stretch. The list below is what these listings asked for that you do not have yet.";
}

export function linesToRoles(current: string, next: string, destination: string, trending: string): CareerRoles {
  const split = (value: string) =>
    value
      .split(/\n|,/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 12);
  return { current: split(current), next: split(next), destination: split(destination), trending: split(trending) };
}

export function buildCareerReport(
  postings: { title: string; description: string; place?: string; remote?: boolean | null }[],
  profileSkills: readonly string[],
  roles: CareerRoles,
): CareerReport {
  const kinds: [CareerKind, string[]][] = [
    ["current", roles.current],
    ["next", roles.next],
    ["destination", roles.destination],
    ["trending", roles.trending],
  ];
  const reports: RoleReport[] = [];
  for (const [kind, names] of kinds) {
    for (const name of names) {
      const row = catalogFor(name);
      const listings = roleListings(postings, name, row.layers);
      const blob = listings.map((posting) => `${posting.title}\n${posting.description}`).join("\n").toLowerCase();
      const owned = new Set(profileSkills.map((skill) => skill.toLowerCase()));
      const have: string[] = [];
      const lacking: string[] = [];
      for (const skill of row.watch) {
        if (!mentions(blob, skill) && listings.length > 0) continue;
        if (listings.length === 0) continue;
        const label = skill;
        if (owned.has(skill)) have.push(label);
        else lacking.push(label);
      }
      reports.push({
        name,
        kind,
        layers: row.layers,
        listingCount: listings.length,
        closeness: closeness(have.length, lacking.length, listings.length),
        nextMove: row.next,
        have,
        lacking,
      });
    }
  }

  const counts = new Map<string, number>();
  for (const posting of postings) {
    const read = assessGap(posting, profileSkills);
    for (const skill of read.missing) counts.set(skill, (counts.get(skill) ?? 0) + 1);
  }
  const checks = [...counts.entries()]
    .map(([skill, mentions]) => ({ skill, mentions }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 12);

  return { roles: reports, checks };
}
