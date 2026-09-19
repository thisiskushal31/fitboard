from __future__ import annotations

from collections import Counter

from .jobs import Job
from .profile import Profile
from .regions import detect_regions

WATCHLIST = [
    "Kubernetes",
    "Terraform",
    "ArgoCD",
    "GitOps",
    "GCP",
    "AWS",
    "Azure",
    "Oracle Cloud",
    "IBM Cloud",
    "Helm",
    "Python",
    "Go",
    "Platform Engineering",
    "SRE",
    "Observability",
    "OpenTelemetry",
    "Prometheus",
    "Grafana",
    "CI/CD",
    "Docker",
    "Linux",
    "IAM",
    "Zero Trust",
    "Kafka",
    "PostgreSQL",
    "Cloud Run",
    "EKS",
    "GKE",
    "Ansible",
    "Pulumi",
    "Crossplane",
    "RAG",
    "LLM",
    "MLflow",
    "Vertex AI",
    "MITRE ATT&CK",
    "detection",
]


def market_trends(jobs: list[Job], profile: Profile) -> dict:
    skill_counts: Counter[str] = Counter()
    title_counts: Counter[str] = Counter()
    source_counts: Counter[str] = Counter()
    region_counts: Counter[str] = Counter()
    remote_yes = 0
    remote_known = 0

    haystacks = []
    for job in jobs:
        haystacks.append(job.haystack)
        source_counts[job.source.split()[0]] += 1
        title = job.title.lower()
        for alias in (
            "software engineer",
            "platform engineer",
            "devops",
            "sre",
            "site reliability",
            "cloud engineer",
            "cloud architect",
            "infrastructure",
            "kubernetes",
        ):
            if alias in title:
                title_counts[alias] += 1
        for region in detect_regions(job.haystack, job.remote):
            region_counts[region] += 1
        if job.remote is not None:
            remote_known += 1
            if job.remote:
                remote_yes += 1
        elif "remote" in job.haystack:
            remote_known += 1
            remote_yes += 1

    blob = " \n ".join(haystacks)
    owned = {s.lower() for s in profile.all_skills}
    owned.update({"k8s", "google cloud", "ci/cd", "argo cd"})
    for skill in WATCHLIST:
        needle = skill.lower()
        count = blob.count(needle)
        if count:
            skill_counts[skill] = count

    demand = skill_counts.most_common(18)
    you_have = [(name, count) for name, count in demand if name.lower() in owned or name in profile.all_skills]
    gaps = [(name, count) for name, count in demand if name.lower() not in owned and name not in profile.all_skills]

    return {
        "job_count": len(jobs),
        "skill_demand": demand,
        "you_have": you_have[:10],
        "gaps": gaps[:10],
        "role_titles": title_counts.most_common(10),
        "regions": region_counts.most_common(10),
        "sources": source_counts.most_common(),
        "remote_share": round((remote_yes / remote_known) * 100) if remote_known else None,
        "remote_known": remote_known,
    }
