from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import yaml

from .jobs import Job, collect_jobs
from .profile import ROOT, Profile, load_profile

PATH_FILE = ROOT / "data" / "career-path.yaml"
OUT_DIR = ROOT / "out"

# Four layers that survive title churn. New roles are mixes of these.
LAYERS = ("software", "platform", "ai", "security")

# Known roles: layers + skills boards use + the next proof to ship.
# Add a row here only when a title keeps showing up. For a one-minute
# trending title, YAML is enough — unknown names still get a live gap list.
ROLE_CATALOG: dict[str, dict] = {
    "devops engineer": {
        "layers": ["platform"],
        "watch": [
            "kubernetes",
            "terraform",
            "gitops",
            "ci/cd",
            "aws",
            "gcp",
            "ansible",
            "prometheus",
            "iam",
            "python",
        ],
        "next": "Keep this hot. Do not abandon it while you add software, AI, and security proofs.",
    },
    "platform engineer": {
        "layers": ["platform", "software"],
        "watch": [
            "kubernetes",
            "gitops",
            "terraform",
            "internal developer platform",
            "backstage",
            "crossplane",
            "golden path",
            "multi-tenant",
            "iam",
            "observability",
        ],
        "next": "Treat identity and multi-tenant isolation as product, not as cluster YAML.",
    },
    "mlops engineer": {
        "layers": ["ai", "platform"],
        "watch": [
            "mlflow",
            "vertex ai",
            "sagemaker",
            "kubeflow",
            "feature store",
            "model registry",
            "gpu",
            "vllm",
            "ray",
            "airflow",
        ],
        "next": "One eval set and one serving SLO. Not another GPU node pool.",
    },
    "ai engineer": {
        "layers": ["ai", "software"],
        "watch": [
            "rag",
            "llm",
            "langchain",
            "embeddings",
            "vector",
            "eval",
            "agent",
            "mcp",
            "prompt",
            "qdrant",
        ],
        "next": "RAG over your own notes with a measured eval set, then a tool-calling agent with traces.",
    },
    "software engineer": {
        "layers": ["software"],
        "watch": ["python", "go", "java", "typescript", "testing", "api", "fastapi", "distributed systems"],
        "next": "Ship one multi-tenant API with tests, auth, and traces — not another Terraform module.",
    },
    "forward-deployed engineer": {
        "layers": ["software", "platform"],
        "watch": [
            "python",
            "go",
            "kubernetes",
            "customer",
            "on-site",
            "onsite",
            "integration",
            "api",
            "embeddings",
            "llm",
        ],
        "next": "Keep this in line: sit with a real user problem and ship the integration yourself.",
    },
    "forward deployed engineer": {
        "layers": ["software", "platform"],
        "watch": [
            "python",
            "go",
            "kubernetes",
            "customer",
            "integration",
            "api",
            "embeddings",
            "llm",
        ],
        "next": "Keep this in line: sit with a real user problem and ship the integration yourself.",
    },
    "threat intelligence": {
        "layers": ["security"],
        "watch": [
            "mitre",
            "att&ck",
            "detection",
            "siem",
            "yara",
            "sigma",
            "threat intel",
            "ioc",
            "guardduty",
            "chronicle",
        ],
        "next": "ATT&CK mapped to GCP/AWS logs, three detections, one written brief.",
    },
    "security engineering": {
        "layers": ["security", "platform"],
        "watch": [
            "zero trust",
            "iam",
            "detection",
            "siem",
            "vault",
            "sast",
            "dast",
            "owasp",
            "incident response",
        ],
        "next": "Enter through cloud detection from the Zero Trust work you already shipped. Not Kali-first.",
    },
    "cloud engineer": {
        "layers": ["platform"],
        "watch": ["aws", "gcp", "azure", "terraform", "kubernetes", "iam", "vpc", "networking"],
        "next": "Same jobs you already do. Keep cost and identity as first-class design.",
    },
    "site reliability engineer": {
        "layers": ["platform"],
        "watch": ["slo", "prometheus", "on-call", "kubernetes", "error budget", "observability"],
        "next": "Write SLOs for something you already run. That is the SRE proof.",
    },
}

LAYER_HINTS = {
    "software": ("software", "sde", "swe", "backend", "full stack", "forward-deployed", "forward deployed", "fde"),
    "platform": ("platform", "devops", "sre", "cloud", "infrastructure", "reliability", "mlops"),
    "ai": ("ai ", " ai", "mlops", "machine learning", "llm", "ml engineer", "data scientist"),
    "security": ("security", "cyber", "threat", "detection", "soc ", "appsec", "devsecops"),
}

SHORT_SKILL = {"go", "rag", "llm", "gpu", "iam", "slo", "api", "mcp", "ioc"}


@dataclass
class CareerConfig:
    current_roles: list[str]
    next_roles: list[str]
    destination_roles: list[str]
    trending: list[str]
    learning_now: list[str]
    search_queries: list[str]

    @property
    def all_target_roles(self) -> list[str]:
        return list(
            dict.fromkeys(self.current_roles + self.next_roles + self.destination_roles + self.trending)
        )


@dataclass
class SkillGap:
    skill: str
    mentions: int
    have: bool
    why: str


@dataclass
class RolePath:
    name: str
    kind: str
    layers: list[str]
    listing_count: int
    have: list[SkillGap]
    lacking: list[SkillGap]
    next_move: str
    closeness: str


@dataclass
class CareerReport:
    generated_on: str
    current: list[RolePath]
    next_roles: list[RolePath]
    trending: list[RolePath]
    destination: list[RolePath]
    checks: list[SkillGap]
    job_count: int
    stance: str = (
        "Companies fire without notice. Two layoffs is the evidence. "
        "This path is the plan. A listing is a signal, not a promise."
    )


def _as_names(data: dict, plural: str, singular: str) -> list[str]:
    values = data.get(plural)
    if values is None:
        values = data.get(singular)
    if values is None:
        return []
    if isinstance(values, str):
        return [values] if values.strip() else []
    names: list[str] = []
    for item in values:
        if isinstance(item, str) and item.strip():
            names.append(item.strip())
        elif isinstance(item, dict) and item.get("name"):
            names.append(str(item["name"]).strip())
    return names


def load_career_config(path: Path | None = None) -> CareerConfig:
    data = yaml.safe_load((path or PATH_FILE).read_text()) or {}
    trending = []
    for row in data.get("trending") or []:
        if isinstance(row, str) and row.strip():
            trending.append(row.strip())
            continue
        if isinstance(row, dict) and row.get("active", True) and row.get("name"):
            trending.append(str(row["name"]).strip())
    current = _as_names(data, "current_roles", "current_role") or ["DevOps Engineer"]
    next_roles = _as_names(data, "next_roles", "next_role")
    destination = _as_names(data, "destination_roles", "destination_role") or ["Security Engineering"]
    return CareerConfig(
        current_roles=current,
        next_roles=next_roles,
        destination_roles=destination,
        trending=trending,
        learning_now=[str(x) for x in (data.get("learning_now") or [])],
        search_queries=[str(x) for x in (data.get("search_queries") or [])],
    )


def extra_search_queries(config: CareerConfig | None = None) -> list[str]:
    cfg = config or load_career_config()
    from_roles = [name.lower() for name in cfg.all_target_roles]
    return list(dict.fromkeys(cfg.search_queries + from_roles))


def _norm(name: str) -> str:
    text = (name or "").lower().strip()
    text = text.replace("/", " ").replace("_", " ")
    text = re.sub(r"\s+", " ", text)
    return text


def _catalog_key(name: str) -> str | None:
    n = _norm(name)
    if n in ROLE_CATALOG:
        return n
    for key in ROLE_CATALOG:
        if key in n or n in key:
            return key
    return None


def _layers_for(name: str) -> list[str]:
    key = _catalog_key(name)
    if key:
        return list(ROLE_CATALOG[key]["layers"])
    found = [layer for layer, hints in LAYER_HINTS.items() if any(h in _norm(name) for h in hints)]
    return found or ["software", "platform"]


def _watch_for(name: str) -> list[str]:
    key = _catalog_key(name)
    if key:
        return list(ROLE_CATALOG[key]["watch"])
    return ["python", "kubernetes", "aws", "gcp", "terraform"]


def _next_for(name: str) -> str:
    key = _catalog_key(name)
    if key:
        return str(ROLE_CATALOG[key]["next"])
    layers = ", ".join(_layers_for(name))
    return (
        f"Keep this in line. Layers: {layers}. "
        "Translate the title into those layers, then ship one public proof in 4–6 weeks."
    )


def _owned(profile: Profile, learning_now: list[str]) -> set[str]:
    owned = {s.lower() for s in profile.all_skills}
    owned.update(k.lower() for k in profile.skill_lookup)
    owned.update(s.lower() for s in learning_now)
    owned.update({"k8s", "google cloud", "ci/cd", "argo cd", "vector"})
    if "qdrant" in owned:
        owned.update({"vector", "embeddings"})
    if "trivy" in owned:
        owned.update({"sast", "dast"})
    if "zero trust" in owned:
        owned.add("zero trust")
    return owned


def _has_skill(skill: str, owned: set[str]) -> bool:
    needle = skill.lower()
    if needle in owned:
        return True
    tokens = needle.split()
    for item in owned:
        parts = item.replace("-", " ").replace("/", " ").split()
        if needle in parts:
            return True
        if len(tokens) > 1 and all(tok in parts or tok in item for tok in tokens):
            return True
    return False


def _count_skill(blob: str, skill: str) -> int:
    needle = skill.lower()
    if needle in SHORT_SKILL or len(needle) <= 3:
        return len(re.findall(rf"(?<![a-z0-9]){re.escape(needle)}(?![a-z0-9])", blob))
    return blob.count(needle)


def _role_jobs(jobs: list[Job], name: str) -> list[Job]:
    aliases = {_norm(name)}
    key = _catalog_key(name)
    if key:
        aliases.add(key)
    n = _norm(name)
    if "forward" in n:
        aliases.update({"forward-deployed", "forward deployed", "fde"})
    if "threat" in n:
        aliases.update({"threat intel", "threat intelligence"})
    if "security" in n:
        aliases.add("security engineer")
    if "mlops" in n:
        aliases.add("mlops")
    if "ai engineer" in n or n.endswith("ai"):
        aliases.update({"ai engineer", "machine learning engineer", "llm engineer"})
    aliases = {alias for alias in aliases if len(alias) > 3 or alias == "fde" or alias == "mlops"}
    matched: list[Job] = []
    for job in jobs:
        hay = f"{job.title} {job.company}".lower()
        blob = job.haystack[:500]
        if any(alias in hay or alias in blob for alias in aliases):
            matched.append(job)
    return matched


def _gaps_for(jobs: list[Job], watch: list[str], owned: set[str], role: str) -> tuple[list[SkillGap], list[SkillGap]]:
    blob = " \n ".join(job.haystack for job in jobs)
    have: list[SkillGap] = []
    lacking: list[SkillGap] = []
    for skill in watch:
        mentions = _count_skill(blob, skill) if jobs else 0
        got = _has_skill(skill, owned)
        if jobs and not mentions:
            continue
        if not jobs and got:
            continue
        if not jobs and not got:
            lacking.append(
                SkillGap(
                    skill=skill,
                    mentions=0,
                    have=False,
                    why=(
                        f"You're lacking {skill}. Boards for {role} were thin this crawl; "
                        f"still add it — this role repeats it."
                    ),
                )
            )
            continue
        gap = SkillGap(
            skill=skill,
            mentions=mentions,
            have=got,
            why=(
                f"You already have {skill}."
                if got
                else f"You're lacking {skill}. Add it because {mentions} listing(s) for {role} asked for it this crawl."
            ),
        )
        (have if got else lacking).append(gap)
    have.sort(key=lambda g: g.mentions, reverse=True)
    lacking.sort(key=lambda g: g.mentions, reverse=True)
    return have, lacking[:8]


def _closeness(have: list[SkillGap], lacking: list[SkillGap], listing_count: int) -> str:
    if listing_count == 0:
        return "no listings this crawl — still a plan, not a company"
    if not lacking:
        return "close — boards are repeating skills you already have"
    if have and lacking and lacking[0].mentions >= (have[0].mentions if have else 0):
        return "stretch — boards want proofs you have not shipped yet"
    if have:
        return "in reach — add the lacking skills, do not switch identity"
    return "gap — treat this as a learning track, not a this-week apply list"


def _role_path(jobs: list[Job], name: str, kind: str, owned: set[str]) -> RolePath:
    matched = _role_jobs(jobs, name)
    have, lacking = _gaps_for(matched, _watch_for(name), owned, name)
    return RolePath(
        name=name,
        kind=kind,
        layers=_layers_for(name),
        listing_count=len(matched),
        have=have[:8],
        lacking=lacking[:8],
        next_move=_next_for(name),
        closeness=_closeness(have, lacking, len(matched)),
    )


def build_career_report(jobs: list[Job], profile: Profile, config: CareerConfig | None = None) -> CareerReport:
    cfg = config or load_career_config()
    owned = _owned(profile, cfg.learning_now)
    current = [_role_path(jobs, name, "current", owned) for name in cfg.current_roles]
    next_roles = [_role_path(jobs, name, "next", owned) for name in cfg.next_roles]
    trending = [_role_path(jobs, name, "trending", owned) for name in cfg.trending]
    destination = [_role_path(jobs, name, "destination", owned) for name in cfg.destination_roles]

    checks: list[SkillGap] = []
    seen: set[str] = set()
    for role in next_roles + trending + destination:
        for gap in role.lacking:
            key = gap.skill.lower()
            if key in seen:
                continue
            seen.add(key)
            checks.append(gap)
    checks.sort(key=lambda g: g.mentions, reverse=True)
    return CareerReport(
        generated_on=date.today().isoformat(),
        current=current,
        next_roles=next_roles,
        trending=trending,
        destination=destination,
        checks=checks[:12],
        job_count=len(jobs),
    )


def _role_md(role: RolePath, heading: str) -> list[str]:
    lines = [
        heading,
        f"Layers: {', '.join(role.layers)} · {role.closeness} · {role.listing_count} matching listings.",
        f"Do next: {role.next_move}",
    ]
    if role.kind == "current" and role.have:
        lines.append(
            "Keep hot (boards still ask, you have): "
            + ", ".join(f"{g.skill} ({g.mentions})" for g in role.have[:6])
        )
    for gap in role.lacking[:5]:
        lines.append(f"- {gap.why}")
    if role.kind != "current" and not role.lacking:
        lines.append("- Boards in this crawl are not asking for skills you lack on this track.")
    lines.append("")
    return lines


def render_career_markdown(report: CareerReport) -> str:
    lines = [
        f"# Career path — {report.generated_on}",
        "",
        report.stance,
        "",
        f"Listings scanned: {report.job_count}. Targeting {len(report.current) + len(report.next_roles) + len(report.destination) + len(report.trending)} roles this run.",
        "",
        "## Current roles",
    ]
    for role in report.current:
        lines += _role_md(role, f"### {role.name} — {role.closeness}")
    lines += ["## Next roles"]
    for role in report.next_roles:
        lines += _role_md(role, f"### {role.name} — {role.closeness}")
    if report.trending:
        lines.append("## Trending — keep in line")
        for role in report.trending:
            lines += _role_md(role, f"### {role.name} — {role.closeness}")
    lines.append("## Destination roles")
    for role in report.destination:
        lines += _role_md(role, f"### {role.name} — {role.closeness}")
    lines += ["## Checks this crawl"]
    if not report.checks:
        lines.append("- No new gaps in this batch. Keep shipping the current next-move.")
    for gap in report.checks:
        lines.append(f"- {gap.why}")
    lines += [
        "",
        "Edit `data/career-path.yaml` to add or drop roles. Every list accepts multiple titles. Then run again.",
    ]
    return "\n".join(lines)


def report_to_dict(report: CareerReport) -> dict:
    def role_dump(role: RolePath) -> dict:
        return {
            "name": role.name,
            "kind": role.kind,
            "layers": role.layers,
            "listing_count": role.listing_count,
            "closeness": role.closeness,
            "next_move": role.next_move,
            "have": [{"skill": g.skill, "mentions": g.mentions} for g in role.have],
            "lacking": [{"skill": g.skill, "mentions": g.mentions, "why": g.why} for g in role.lacking],
        }

    return {
        "generated_on": report.generated_on,
        "stance": report.stance,
        "job_count": report.job_count,
        "current": [role_dump(r) for r in report.current],
        "next_roles": [role_dump(r) for r in report.next_roles],
        "trending": [role_dump(r) for r in report.trending],
        "destination": [role_dump(r) for r in report.destination],
        "checks": [{"skill": g.skill, "mentions": g.mentions, "why": g.why} for g in report.checks],
    }


def run_career_path(profile: Profile | None = None, jobs: list[Job] | None = None) -> CareerReport:
    profile = profile or load_profile()
    cfg = load_career_config()
    if jobs is None:
        queries = list(dict.fromkeys(list(profile.search_queries) + extra_search_queries(cfg)))
        jobs, _errors = collect_jobs(queries)
    return build_career_report(jobs, profile, cfg)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Write a company-independent career path from live job boards.")
    parser.add_argument("--json", action="store_true", help="also write out/career-path.json")
    args = parser.parse_args(argv)
    report = run_career_path()
    text = render_career_markdown(report)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "career-path.md").write_text(text + "\n")
    if args.json:
        (OUT_DIR / "career-path.json").write_text(json.dumps(report_to_dict(report), indent=2) + "\n")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
