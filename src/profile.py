from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
PROFILE_PATH = ROOT / "data" / "profile.yaml"

CLOUD_ALIASES: dict[str, tuple[str, ...]] = {
    "AWS": ("aws", "amazon web services", "amazon aws", "eks", "ec2"),
    "GCP": ("gcp", "google cloud", "google cloud platform", "gke", "cloud run"),
    "Azure": ("azure", "microsoft azure", "aks", "azure kubernetes"),
    "Oracle Cloud": ("oracle cloud", " oci ", "oci,", "oke", "oracle oci"),
    "IBM Cloud": ("ibm cloud", "ibm vpc", "iks", "roks"),
    "Alibaba Cloud": ("alibaba", "aliyun", "ali cloud", "ack"),
    "Tencent Cloud": ("tencent cloud", "tencent", "tke"),
    "Huawei Cloud": ("huawei cloud", "huawei"),
    "OVHcloud": ("ovhcloud", "ovh cloud", "ovh"),
    "Open Telekom Cloud": ("open telekom", "otc", "t-systems", "deutsche telekom"),
    "CtrlS": ("ctrls",),
    "Yotta": ("yotta",),
    "Linode": ("linode", "akamai cloud", "akamai linode"),
    "DigitalOcean": ("digitalocean", "digital ocean"),
    "Cloudflare": ("cloudflare",),
}


@dataclass
class Profile:
    name: str
    headline: str
    years_experience: float
    location: str
    open_to: list[str]
    target_roles: list[str]
    role_aliases: dict[str, float]
    core_skills: list[str]
    supporting_skills: list[str]
    keywords: list[str]
    exclude_title_terms: list[str]
    search_queries: list[str]
    confident_clouds: list[str] = field(default_factory=list)
    also_ok_clouds: list[str] = field(default_factory=list)
    target_regions: list[str] = field(default_factory=list)
    all_skills: list[str] = field(default_factory=list)

    @property
    def wanted_regions(self) -> list[str]:
        open_l = {item.lower() for item in self.open_to}
        canonical = [
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
        ]
        if "global" in open_l:
            return list(self.target_regions) or canonical
        mapped: list[str] = []
        alias = {
            "remote": "Remote",
            "india": "India",
            "apac": "APAC",
            "eac": "APAC",
            "emea": "EMEA",
            "uk": "UK",
            "singapore": "Singapore",
            "sg": "Singapore",
            "middle east": "Middle East",
            "uae": "Middle East",
            "gcc": "Middle East",
            "germany": "Germany",
            "de": "Germany",
            "nordics": "Nordics",
            "nordic": "Nordics",
            "scandinavia": "Nordics",
            "sweden": "Nordics",
            "norway": "Nordics",
            "finland": "Nordics",
            "denmark": "Nordics",
            "iceland": "Nordics",
            "us": "US",
            "usa": "US",
            "americas": "Americas",
        }
        for item in self.open_to + self.target_regions:
            key = alias.get(item.lower())
            if key:
                mapped.append(key)
        return list(dict.fromkeys(mapped)) or canonical

    @property
    def all_clouds(self) -> list[str]:
        return list(dict.fromkeys(self.confident_clouds + self.also_ok_clouds))

    @property
    def skill_lookup(self) -> dict[str, str]:
        lookup: dict[str, str] = {}
        for skill in self.all_skills:
            lookup[skill.lower()] = skill
            lookup[skill.lower().replace(" ", "")] = skill
        extras = {
            "k8s": "Kubernetes",
            "gke": "GKE",
            "eks": "EKS",
            "aks": "AKS",
            "gcp": "GCP",
            "google cloud": "GCP",
            "google cloud platform": "GCP",
            "amazon web services": "AWS",
            "microsoft azure": "Azure",
            "terraform": "Terraform",
            "opentofu": "OpenTofu",
            "argo cd": "ArgoCD",
            "argo-cd": "ArgoCD",
            "argocd": "ArgoCD",
            "ci/cd": "CI/CD",
            "cicd": "CI/CD",
            "iac": "Infrastructure as Code",
            "infrastructure as code": "Infrastructure as Code",
            "otel": "OpenTelemetry",
            "opentelemetry": "OpenTelemetry",
            "prometheus": "Prometheus",
            "site reliability": "SRE",
        }
        lookup.update(extras)
        return lookup


def load_profile(path: Path | None = None) -> Profile:
    data = yaml.safe_load((path or PROFILE_PATH).read_text())
    core = list(data.get("skills", {}).get("core", []))
    supporting = list(data.get("skills", {}).get("supporting", []))
    clouds = data.get("clouds") or {}
    return Profile(
        name=data["name"],
        headline=data["headline"],
        years_experience=float(data["years_experience"]),
        location=data["location"],
        open_to=list(data.get("open_to", [])),
        target_roles=list(data.get("target_roles", [])),
        role_aliases={str(k).lower(): float(v) for k, v in data.get("role_aliases", {}).items()},
        core_skills=core,
        supporting_skills=supporting,
        keywords=list(data.get("keywords", [])),
        exclude_title_terms=[t.lower() for t in data.get("exclude_title_terms", [])],
        search_queries=list(data.get("search_queries", [])),
        confident_clouds=list(clouds.get("confident") or ["AWS", "GCP"]),
        also_ok_clouds=list(clouds.get("also_ok") or ["Azure"]),
        target_regions=list(data.get("regions") or []),
        all_skills=core + supporting,
    )
