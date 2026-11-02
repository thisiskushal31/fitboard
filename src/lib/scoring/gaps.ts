// Skill-led read of one posting against the profile.
// The title is optional: a generic Software Engineer listing can still be
// suited when the skills match. Skills the posting asks for and the profile
// does not have are a gap. They are not resume lines.

import { detectRegions, regionRank, type Region } from "@/lib/job-search/regions";

export type GapFit = "suited" | "stretch" | "not_suited";

export type GapRead = {
  fit: GapFit;
  label: string;
  /** Skills the posting asks for that are already on the profile. */
  matched: string[];
  /** Skills the posting asks for that the profile does not have. */
  missing: string[];
  regions: Region[];
  regionRank: number;
  /** Always true of `missing`: do not write these onto the resume. */
  resumeNote: string;
};

const LABELS: Record<GapFit, string> = {
  suited: "Suited",
  stretch: "Stretch",
  not_suited: "Not suited",
};

export const RESUME_GAP_NOTE = "Add these skills before you claim them. Do not put them on the resume until you have them.";

/** Skills a posting may name. The value is the label shown once. */
const MARKET_SKILLS: readonly [string, string][] = [
  ["kubernetes", "Kubernetes"],
  ["k8s", "Kubernetes"],
  ["terraform", "Terraform"],
  ["opentofu", "OpenTofu"],
  ["argocd", "ArgoCD"],
  ["argo cd", "ArgoCD"],
  ["helm", "Helm"],
  ["gitops", "GitOps"],
  ["aws", "AWS"],
  ["google cloud", "GCP"],
  ["gcp", "GCP"],
  ["azure", "Azure"],
  ["eks", "EKS"],
  ["gke", "GKE"],
  ["aks", "AKS"],
  ["python", "Python"],
  ["golang", "Go"],
  [" go ", "Go"],
  ["java", "Java"],
  ["rust", "Rust"],
  ["typescript", "TypeScript"],
  ["docker", "Docker"],
  ["linux", "Linux"],
  ["prometheus", "Prometheus"],
  ["grafana", "Grafana"],
  ["opentelemetry", "OpenTelemetry"],
  ["otel", "OpenTelemetry"],
  ["kafka", "Kafka"],
  ["postgresql", "PostgreSQL"],
  ["ansible", "Ansible"],
  ["pulumi", "Pulumi"],
  ["crossplane", "Crossplane"],
  ["istio", "Istio"],
  ["vault", "Vault"],
  ["iam", "IAM"],
  ["ci/cd", "CI/CD"],
  ["github actions", "GitHub Actions"],
  ["gitlab ci", "GitLab CI"],
  ["jenkins", "Jenkins"],
  ["openshift", "OpenShift"],
  ["cloud run", "Cloud Run"],
  ["observability", "Observability"],
  ["slo", "SLO"],
  ["on-call", "On-call"],
  ["networking", "Networking"],
  ["oracle cloud", "Oracle Cloud"],
  ["ibm cloud", "IBM Cloud"],
  ["cloudflare", "Cloudflare"],
  ["rag", "RAG"],
  ["llm", "LLM"],
  ["mitre", "MITRE ATT&CK"],
  ["siem", "SIEM"],
  ["backstage", "Backstage"],
];

const ROLE_HINTS = ["devops", "sre", "site reliability", "platform", "cloud", "kubernetes", "infrastructure", "mlops", "security", "backend", "software engineer", "software development", "sde", "swe"];

function contains(blob: string, needle: string): boolean {
  const token = needle.trim().toLowerCase();
  if (token.length < 2) return false;
  if (needle.startsWith(" ") || needle.endsWith(" ")) return ` ${blob} `.includes(needle.toLowerCase());
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`, "i").test(blob);
}

export function skillsAsked(text: string): string[] {
  const blob = ` ${(text || "").toLowerCase()} `;
  const found: string[] = [];
  for (const [needle, label] of MARKET_SKILLS) {
    if (contains(blob, needle) && !found.includes(label)) found.push(label);
  }
  return found;
}

function ownedSet(profileSkills: readonly string[]): Set<string> {
  return new Set(profileSkills.map((skill) => skill.trim().toLowerCase()).filter(Boolean));
}

function profileHas(label: string, owned: Set<string>): boolean {
  const key = label.toLowerCase();
  if (owned.has(key)) return true;
  const aliases: Record<string, readonly string[]> = {
    gcp: ["google cloud"],
    kubernetes: ["k8s"],
    "mitre att&ck": ["mitre"],
    go: ["golang"],
  };
  return (aliases[key] ?? []).some((alias) => owned.has(alias));
}

function classify(matched: number, missing: number, roleHit: boolean): GapFit {
  // Skill-led: enough overlapping skills qualify the listing even when the title is generic.
  if (matched >= 3 && missing <= 4) return "suited";
  if (matched >= 2 && missing <= 2) return "suited";
  if (matched >= 2) return "stretch";
  if (matched >= 1 && (roleHit || missing <= 3)) return "stretch";
  if (roleHit && matched === 0 && missing > 0) return "not_suited";
  if (matched === 0) return "not_suited";
  return "stretch";
}

export function assessGap(
  posting: { title: string; description: string; place?: string; remote?: boolean | null },
  profileSkills: readonly string[],
): GapRead {
  const blob = `${posting.title}\n${posting.place ?? ""}\n${posting.description}`;
  const asked = skillsAsked(blob);
  const owned = ownedSet(profileSkills);
  const matched = asked.filter((skill) => profileHas(skill, owned));
  const missing = asked.filter((skill) => !profileHas(skill, owned));
  const title = posting.title.toLowerCase();
  const roleHit = ROLE_HINTS.some((hint) => title.includes(hint));
  const fit = classify(matched.length, missing.length, roleHit);
  const regions = detectRegions(blob, posting.remote ?? null);
  return {
    fit,
    label: LABELS[fit],
    matched,
    missing,
    regions,
    regionRank: regionRank(regions),
    resumeNote: missing.length > 0 ? RESUME_GAP_NOTE : "Nothing in this posting is a skill gap against the profile.",
  };
}
