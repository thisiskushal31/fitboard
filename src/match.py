"""Score listings against the profile: role, skills, clouds, region, recency."""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import date, datetime

from .jobs import Job
from .profile import CLOUD_ALIASES, Profile
from .regions import location_score as region_location_score

WORD_RE = re.compile(r"[a-z0-9+#./-]+")
YEARS_RE = re.compile(r"(\d+)\s*\+?\s*(?:years?|yrs?)\b", re.I)
NOT_SUITED_PREFIX = "I am not suited, but this is what you need to get suited here"

# Skills the JD may ask for that are not always on the profile.
MARKET_SKILLS: dict[str, str] = {
    "kubernetes": "Kubernetes",
    "k8s": "Kubernetes",
    "terraform": "Terraform",
    "opentofu": "OpenTofu",
    "argocd": "ArgoCD",
    "argo cd": "ArgoCD",
    "helm": "Helm",
    "gitops": "GitOps",
    "aws": "AWS",
    "gcp": "GCP",
    "google cloud": "GCP",
    "azure": "Azure",
    "eks": "EKS",
    "gke": "GKE",
    "aks": "AKS",
    "python": "Python",
    "golang": "Go",
    " go ": "Go",
    "java": "Java",
    "rust": "Rust",
    "docker": "Docker",
    "linux": "Linux",
    "prometheus": "Prometheus",
    "grafana": "Grafana",
    "opentelemetry": "OpenTelemetry",
    "otel": "OpenTelemetry",
    "kafka": "Kafka",
    "postgresql": "PostgreSQL",
    "ansible": "Ansible",
    "pulumi": "Pulumi",
    "crossplane": "Crossplane",
    "istio": "Istio",
    "vault": "Vault",
    "iam": "IAM",
    "ci/cd": "CI/CD",
    "github actions": "GitHub Actions",
    "gitlab ci": "GitLab CI",
    "jenkins": "Jenkins",
    "openshift": "OpenShift",
    "lambda": "AWS Lambda",
    "cloud run": "Cloud Run",
    "observability": "Observability",
    "slo": "SLO",
    "on-call": "On-call",
    "networking": "Networking",
    "oci": "Oracle Cloud",
    "oracle cloud": "Oracle Cloud",
    "ibm cloud": "IBM Cloud",
    "alibaba": "Alibaba Cloud",
    "tencent cloud": "Tencent Cloud",
    "huawei cloud": "Huawei Cloud",
    "ovh": "OVHcloud",
    "linode": "Linode",
    "digitalocean": "DigitalOcean",
    "cloudflare": "Cloudflare",
}

CLOUD_HOW_TO = {
    "Azure": "Azure (AKS, Entra ID, ARM/Bicep) — map the same jobs you already do on AWS/GCP",
    "Oracle Cloud": "Oracle Cloud (OKE, compartments) — same platform work, OCI names",
    "IBM Cloud": "IBM Cloud (VPC, IKS/ROKS) — same platform work, IBM names",
    "Alibaba Cloud": "Alibaba Cloud (ACK, ECS) — same jobs, Aliyun names",
    "Tencent Cloud": "Tencent Cloud (TKE, CVM) — same jobs, Tencent names",
    "Huawei Cloud": "Huawei Cloud (CCE) — same jobs, Huawei names",
    "OVHcloud": "OVHcloud (Public Cloud / MKS) — EU cloud literacy",
    "Open Telekom Cloud": "Open Telekom Cloud / T-Systems — EU sovereign cloud literacy",
    "CtrlS": "CtrlS hosted private / regional cloud — India colo + tenant cloud",
    "Yotta": "Yotta hosted private / regional cloud — India colo + tenant cloud",
    "Linode": "Akamai Linode / VPS kin — tenant VPS is not colo",
    "DigitalOcean": "DigitalOcean — VPS/Kubernetes droplet literacy",
    "Cloudflare": "Cloudflare — edge, DNS, WAF, Workers",
    "AWS": "AWS production depth (EKS, IAM, VPC) — already a confident cloud",
    "GCP": "GCP production depth (GKE, IAM, VPC) — already a confident cloud",
}

SENIOR_TITLE_MARKERS = (
    "staff ",
    "staff engineer",
    "principal",
    "distinguished",
    "fellow",
    "architect ii",
    "senior staff",
)

WRONG_TRACK = (
    "frontend",
    "front-end",
    "front end",
    "android",
    "ios engineer",
    "mobile engineer",
    "product designer",
    "graphic designer",
    "data scientist",
)


def _tokens(text: str) -> set[str]:
    return {t for t in WORD_RE.findall(text.lower()) if len(t) > 1}


def _age_days(posted_at: str) -> int | None:
    if not posted_at:
        return None
    try:
        posted = datetime.strptime(posted_at[:10], "%Y-%m-%d").date()
        return max((date.today() - posted).days, 0)
    except ValueError:
        return None


def _contains(blob: str, needle: str) -> bool:
    if len(needle.strip()) < 2:
        return False
    if needle.startswith(" ") or needle.endswith(" "):
        return needle in f" {blob} "
    return re.search(rf"(?<![a-z0-9]){re.escape(needle.strip())}(?![a-z0-9])", blob) is not None


def detect_clouds(blob: str, profile: Profile) -> list[str]:
    found: list[str] = []
    padded = f" {blob} "
    for name in profile.all_clouds:
        aliases = CLOUD_ALIASES.get(name, (name.lower(),))
        hit = False
        for alias in aliases:
            if alias.startswith(" ") or alias.endswith(" ") or alias.endswith(","):
                hit = alias in padded
            else:
                hit = _contains(blob, alias)
            if hit:
                break
        if hit and name not in found:
            found.append(name)
    return found


def detect_market_skills(blob: str) -> list[str]:
    padded = f" {blob} "
    found: list[str] = []
    seen: set[str] = set()
    for needle, canonical in MARKET_SKILLS.items():
        hay = padded if needle.startswith(" ") or needle.endswith(" ") else blob
        if _contains(hay, needle) and canonical not in seen:
            seen.add(canonical)
            found.append(canonical)
    return found


def _required_years(blob: str) -> int | None:
    years = [int(m.group(1)) for m in YEARS_RE.finditer(blob)]
    if not years:
        return None
    return max(years)


@dataclass
class ScoredJob:
    """A listing plus fit bucket, matched skills/clouds, and a gap plan."""
    job: Job
    score: float
    role_score: float
    skill_score: float
    location_score: float
    recency_score: float
    matched_skills: list[str] = field(default_factory=list)
    missing_skills: list[str] = field(default_factory=list)
    matched_role: str = ""
    matched_clouds: list[str] = field(default_factory=list)
    cloud_fit: str = "unspecified"
    fit: str = "suited"
    fit_summary: str = ""
    gap_plan: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    regions: list[str] = field(default_factory=list)


def _cloud_fit(matched_clouds: list[str], profile: Profile) -> str:
    if not matched_clouds:
        return "unspecified"
    if any(c in profile.confident_clouds for c in matched_clouds):
        return "confident"
    if any(c in profile.also_ok_clouds for c in matched_clouds):
        return "transferable"
    return "other"


def _gap_plan(
    *,
    missing_skills: list[str],
    matched_clouds: list[str],
    cloud_fit: str,
    profile: Profile,
    title: str,
    required_years: int | None,
) -> list[str]:
    gaps: list[str] = []
    owned = {s.lower() for s in profile.all_skills}
    skill_gaps = [s for s in missing_skills if s.lower() not in owned][:8]
    for skill in skill_gaps:
        if skill in CLOUD_HOW_TO:
            continue
        gaps.append(skill)

    if cloud_fit == "transferable":
        for cloud in matched_clouds:
            if cloud not in profile.confident_clouds and cloud in CLOUD_HOW_TO:
                gaps.append(CLOUD_HOW_TO[cloud])
    elif cloud_fit == "other":
        for cloud in matched_clouds:
            gaps.append(CLOUD_HOW_TO.get(cloud, f"{cloud} literacy — map the same platform work onto this cloud"))

    if required_years and required_years > profile.years_experience + 0.5:
        gaps.append(
            f"{required_years}+ years listed (you have {profile.years_experience}+) — cover with production ownership, not title inflation"
        )
    if any(marker in title for marker in SENIOR_TITLE_MARKERS):
        gaps.append("Staff/principal seniority — need a deeper architecture + incident ownership narrative")
    return list(dict.fromkeys(gaps))


def _classify(
    *,
    role_score: float,
    core_hits: int,
    support_hits: int,
    skill_hits: int,
    cloud_fit: str,
    gap_plan: list[str],
    matched_role: str,
) -> str:
    """suited / stretch / not_suited. Hard seniority or language gaps push not_suited."""
    hard_gaps = [g for g in gap_plan if "years listed" in g or "Staff/principal" in g or g in ("Java", "Rust", "OpenShift", "Istio", "Pulumi", "Crossplane")]
    if skill_hits == 0 and role_score < 0.5:
        return "not_suited"
    if hard_gaps and core_hits < 3:
        return "not_suited"
    if cloud_fit == "transferable" and core_hits < 2 and role_score < 0.7:
        return "stretch" if skill_hits or role_score >= 0.5 else "not_suited"
    if role_score >= 0.7 and core_hits >= 2:
        return "suited"
    if role_score >= 0.5 and core_hits >= 1:
        return "suited"
    if core_hits >= 3:
        return "suited"
    if core_hits >= 2 or (matched_role and skill_hits >= 2):
        return "stretch" if gap_plan else "suited"
    if role_score >= 0.55 and skill_hits >= 1:
        return "stretch"
    if role_score >= 0.35 or core_hits >= 1 or support_hits >= 2:
        return "stretch" if not hard_gaps else "not_suited"
    return "not_suited"


def score_job(job: Job, profile: Profile) -> ScoredJob | None:
    """Return a scored listing, or None when the title is excluded or off-track."""
    title = job.title.lower()
    if any(term in title for term in profile.exclude_title_terms):
        return None

    haystack = job.haystack
    role_score = 0.0
    matched_role = ""
    for alias, weight in profile.role_aliases.items():
        if alias in title:
            if weight > role_score:
                role_score = weight
                matched_role = alias
        elif alias in haystack and weight * 0.55 > role_score:
            role_score = weight * 0.55
            matched_role = alias

    lookup = profile.skill_lookup
    matched: list[str] = []
    seen_canonical: set[str] = set()
    blob = f"{title} {' '.join(job.tags).lower()} {job.description[:2500].lower()}"
    for key, canonical in lookup.items():
        if len(key) < 3:
            continue
        if _contains(blob, key) and canonical not in seen_canonical:
            seen_canonical.add(canonical)
            matched.append(canonical)

    asked_skills = detect_market_skills(blob)
    owned = {s.lower() for s in profile.all_skills}
    missing = [s for s in asked_skills if s.lower() not in owned and s not in matched]
    matched_clouds = detect_clouds(blob, profile)
    cloud_fit = _cloud_fit(matched_clouds, profile)
    required_years = _required_years(blob)

    core_hits = sum(1 for s in matched if s in profile.core_skills)
    support_hits = sum(1 for s in matched if s in profile.supporting_skills)
    skill_hits = core_hits + support_hits

    if any(term in title for term in WRONG_TRACK) and core_hits < 2:
        return None
    skill_score = min(1.0, (core_hits * 0.14) + (support_hits * 0.06))

    # Title-only Software Engineer / SDE still counts if skills or clouds are present.
    skill_led = skill_hits >= 2 or (core_hits >= 1 and matched_clouds)
    if role_score < 0.35 and not skill_led:
        return None
    if role_score < 0.35 and skill_led:
        role_score = max(role_score, 0.55)
        matched_role = matched_role or "skills match (title not listed)"

    location_blob = f"{job.location} {haystack}"
    location_score, regions = region_location_score(location_blob, job.remote, profile)

    days = _age_days(job.posted_at)
    if days is None:
        recency_score = 0.55
    elif days <= 3:
        recency_score = 1.0
    elif days <= 14:
        recency_score = 0.8
    elif days <= 30:
        recency_score = 0.55
    else:
        recency_score = 0.25

    keyword_bonus = 0.0
    for keyword in profile.keywords:
        if keyword in haystack:
            keyword_bonus += 0.03
    keyword_bonus = min(keyword_bonus, 0.12)

    cloud_bonus = 0.0
    if cloud_fit == "confident":
        cloud_bonus = 0.08
    elif cloud_fit == "transferable":
        cloud_bonus = 0.04

    # Skills outweigh title. Region and recency are tie-breakers.
    score = (
        0.34 * role_score
        + 0.36 * skill_score
        + 0.13 * location_score
        + 0.13 * recency_score
        + keyword_bonus
        + cloud_bonus
    ) * 100

    gap_plan = _gap_plan(
        missing_skills=missing,
        matched_clouds=matched_clouds,
        cloud_fit=cloud_fit,
        profile=profile,
        title=title,
        required_years=required_years,
    )
    fit = _classify(
        role_score=role_score,
        core_hits=core_hits,
        support_hits=support_hits,
        skill_hits=skill_hits,
        cloud_fit=cloud_fit,
        gap_plan=gap_plan,
        matched_role=matched_role,
    )

    if fit == "suited":
        cloud_bit = ", ".join(matched_clouds) if matched_clouds else "cloud-agnostic / unspecified"
        fit_summary = f"Suited — {matched_role or 'skill match'} · {cloud_bit}"
    elif fit == "stretch":
        need = "; ".join(gap_plan[:5]) if gap_plan else "partial skill overlap"
        fit_summary = f"Stretch — {need}"
    else:
        need = "; ".join(gap_plan[:6]) if gap_plan else "not enough overlapping skills on this listing"
        fit_summary = f"{NOT_SUITED_PREFIX}: {need}."

    reasons: list[str] = []
    if matched_role:
        reasons.append(f"Role fit: {matched_role}")
    if matched:
        reasons.append("Skills: " + ", ".join(matched[:8]))
    if matched_clouds:
        reasons.append("Cloud: " + ", ".join(matched_clouds) + f" ({cloud_fit})")
    if regions:
        reasons.append("Region: " + ", ".join(regions))
    elif location_score >= 0.9:
        reasons.append("Location/remote looks workable")
    if days is not None and days <= 14:
        reasons.append(f"Posted {days}d ago")

    return ScoredJob(
        job=job,
        score=round(score, 1),
        role_score=role_score,
        skill_score=skill_score,
        location_score=location_score,
        recency_score=recency_score,
        matched_skills=matched,
        missing_skills=missing,
        matched_role=matched_role,
        matched_clouds=matched_clouds,
        cloud_fit=cloud_fit,
        fit=fit,
        fit_summary=fit_summary,
        gap_plan=gap_plan,
        reasons=reasons,
        regions=regions,
    )


def rank_jobs(jobs: list[Job], profile: Profile, limit: int = 80) -> list[ScoredJob]:
    """Suited first, then stretch, then not-suited — each bucket by score descending."""
    suited: list[ScoredJob] = []
    stretch: list[ScoredJob] = []
    not_suited: list[ScoredJob] = []
    for job in jobs:
        result = score_job(job, profile)
        if not result:
            continue
        if result.fit == "suited":
            suited.append(result)
        elif result.fit == "stretch":
            stretch.append(result)
        else:
            not_suited.append(result)
    for bucket in (suited, stretch, not_suited):
        bucket.sort(key=lambda item: item.score, reverse=True)
    return suited[:limit] + stretch[:40] + not_suited[:20]
