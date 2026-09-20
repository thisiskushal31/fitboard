"""Company ATS fetchers (Greenhouse, Lever, Ashby, Recruitee, SmartRecruiters) and RSS."""

from __future__ import annotations

import xml.etree.ElementTree as ET
from pathlib import Path

import yaml

from .jobs import Job, _get, _parse_date, strip_html

ROOT = Path(__file__).resolve().parent.parent
BOARDS_PATH = ROOT / "data" / "company-boards.yaml"

ROLE_HINTS = (
    "devops",
    "sre",
    "site reliability",
    "platform engineer",
    "platform engineering",
    "infrastructure engineer",
    "infrastructure architect",
    "cloud engineer",
    "cloud architect",
    "kubernetes",
    "gitops",
    "production engineer",
    "reliability engineer",
    "systems engineer",
    "site reliability engineer",
    "infra",
    "software engineer",
    "software development engineer",
    "backend engineer",
    "backend developer",
    "mlops",
    "ai engineer",
    "machine learning engineer",
    "security engineer",
    "detection engineer",
    "threat intelligence",
    "forward deployed",
    "forward-deployed",
)

SKILL_HINTS = (
    "kubernetes",
    "k8s",
    "terraform",
    "gitops",
    "argocd",
    "helm",
    "devops",
    "sre",
    "site reliability",
    "platform engineer",
    "cloud engineer",
    "aws",
    "gcp",
    "azure",
    "gke",
    "eks",
    "aks",
    "observability",
    "prometheus",
    "infrastructure",
    "reliability engineer",
    "production engineer",
    "oci",
    "oracle cloud",
    "ibm cloud",
)


def load_boards(path: Path | None = None) -> dict:
    return yaml.safe_load((path or BOARDS_PATH).read_text()) or {}


def official_careers(path: Path | None = None) -> list[dict]:
    return list(load_boards(path).get("official_careers") or [])


def is_target_role(title: str) -> bool:
    blob = (title or "").lower()
    return any(hint in blob for hint in ROLE_HINTS)


def is_relevant_listing(title: str, description: str = "") -> bool:
    """Keep a listing if the title is a target role or the JD is skill/cloud-led."""
    title_l = (title or "").lower()
    desc_l = (description or "")[:2500].lower()
    blob = f"{title_l} {desc_l}"
    skill_hits = sum(1 for hint in SKILL_HINTS if hint in blob)
    if skill_hits >= 2:
        return True
    if is_target_role(title) and skill_hits >= 1:
        return True
    specialized = any(
        token in title_l
        for token in (
            "devops",
            "sre",
            "platform",
            "cloud",
            "reliability",
            "infrastructure",
            "infra",
            "kubernetes",
            "gitops",
            "backend",
            "site reliability",
            "mlops",
            "ai engineer",
            "machine learning",
            "security",
            "detection",
            "threat intel",
            "forward-deployed",
            "forward deployed",
        )
    )
    if specialized:
        return True
    return False


def fetch_greenhouse(company: str, board: str) -> list[Job]:
    """Public Greenhouse board JSON, including full job HTML when the board publishes it."""
    resp = _get(
        f"https://boards-api.greenhouse.io/v1/boards/{board}/jobs",
        params={"content": "true"},
    )
    resp.raise_for_status()
    jobs: list[Job] = []
    for item in resp.json().get("jobs", []):
        title = item.get("title") or ""
        desc = strip_html(item.get("content"))
        if not is_relevant_listing(title, desc):
            continue
        loc = (item.get("location") or {}).get("name") or ""
        jobs.append(
            Job(
                id=f"greenhouse-{board}-{item.get('id')}",
                source=f"Greenhouse · {company}",
                title=title,
                company=company,
                url=item.get("absolute_url") or "",
                location=loc,
                description=desc,
                posted_at=_parse_date(item.get("updated_at") or item.get("created_at")),
                remote="remote" in loc.lower() or "remote" in title.lower() or "remote" in desc.lower(),
            )
        )
    return jobs


def fetch_lever(company: str, board: str) -> list[Job]:
    resp = _get(f"https://api.lever.co/v0/postings/{board}", params={"mode": "json"})
    resp.raise_for_status()
    jobs: list[Job] = []
    payload = resp.json()
    if not isinstance(payload, list):
        return jobs
    for item in payload:
        title = item.get("text") or ""
        desc = strip_html(item.get("descriptionPlain") or item.get("description"))
        if not is_relevant_listing(title, desc):
            continue
        cats = item.get("categories") or {}
        loc = cats.get("location") or ""
        jobs.append(
            Job(
                id=f"lever-{board}-{item.get('id')}",
                source=f"Lever · {company}",
                title=title,
                company=company,
                url=item.get("hostedUrl") or item.get("applyUrl") or "",
                location=loc,
                description=desc,
                posted_at=_parse_date((item.get("createdAt") or 0) / 1000 if item.get("createdAt") else ""),
                remote="remote" in loc.lower() or "remote" in title.lower(),
            )
        )
    return jobs


def fetch_ashby(company: str, board: str) -> list[Job]:
    resp = _get(f"https://api.ashbyhq.com/posting-api/job-board/{board}")
    resp.raise_for_status()
    jobs: list[Job] = []
    for item in resp.json().get("jobs", []):
        title = item.get("title") or ""
        desc = strip_html(item.get("descriptionHtml") or item.get("descriptionPlain"))
        if not is_relevant_listing(title, desc):
            continue
        loc = item.get("location") or ""
        if isinstance(loc, dict):
            loc = loc.get("locationName") or loc.get("name") or ""
        jobs.append(
            Job(
                id=f"ashby-{board}-{item.get('id') or item.get('jobId')}",
                source=f"Ashby · {company}",
                title=title,
                company=company,
                url=item.get("jobUrl") or item.get("applyUrl") or "",
                location=str(loc),
                description=desc,
                posted_at=_parse_date(item.get("publishedDate") or item.get("publishedAt")),
                remote=bool(item.get("isRemote")) or "remote" in str(loc).lower(),
            )
        )
    return jobs


def fetch_wwr(feed_url: str) -> list[Job]:
    resp = _get(feed_url, headers={"Accept": "application/rss+xml, application/xml, text/xml"})
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    jobs: list[Job] = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        desc = strip_html(item.findtext("description"))
        if not is_relevant_listing(title, desc):
            continue
        link = (item.findtext("link") or "").strip()
        company = title.split(":")[0].strip() if ":" in title else "We Work Remotely"
        jobs.append(
            Job(
                id=f"wwr-{link or title}",
                source="We Work Remotely",
                title=title,
                company=company,
                url=link,
                description=desc,
                posted_at=_parse_date(item.findtext("pubDate")),
                remote=True,
            )
        )
    return jobs


def fetch_berlin_rss(feed_url: str) -> list[Job]:
    resp = _get(feed_url, headers={"Accept": "application/rss+xml, application/xml, text/xml"})
    resp.raise_for_status()
    root = ET.fromstring(resp.content)
    jobs: list[Job] = []
    for item in root.findall(".//item"):
        title = (item.findtext("title") or "").strip()
        desc = strip_html(item.findtext("description") or item.findtext("{http://purl.org/rss/1.0/modules/content/}encoded"))
        if not is_relevant_listing(title, desc):
            continue
        link = (item.findtext("link") or "").strip()
        company = title.split(":")[0].strip() if ":" in title else "Berlin startup"
        jobs.append(
            Job(
                id=f"berlin-{link or title}",
                source="Berlin Startup Jobs",
                title=title,
                company=company,
                url=link,
                location="Berlin, Germany",
                description=desc,
                posted_at=_parse_date(item.findtext("pubDate")),
                remote="remote" in f"{title} {desc}".lower(),
            )
        )
    return jobs


def fetch_recruitee(company: str, board: str) -> list[Job]:
    resp = _get(f"https://{board}.recruitee.com/api/offers/")
    resp.raise_for_status()
    jobs: list[Job] = []
    for item in resp.json().get("offers") or []:
        title = item.get("title") or ""
        desc = strip_html(item.get("description") or item.get("requirements"))
        if not is_relevant_listing(title, desc):
            continue
        loc = item.get("location") or item.get("city") or ""
        jobs.append(
            Job(
                id=f"recruitee-{board}-{item.get('id')}",
                source=f"Recruitee · {company}",
                title=title,
                company=company,
                url=item.get("careers_url") or item.get("careers_apply_url") or "",
                location=str(loc),
                description=desc,
                posted_at=_parse_date(item.get("published_at") or item.get("created_at")),
                remote=bool(item.get("remote")) or "remote" in str(loc).lower(),
            )
        )
    return jobs


def fetch_smartrecruiters(company: str, board: str) -> list[Job]:
    jobs: list[Job] = []
    offset = 0
    while True:
        resp = _get(
            f"https://api.smartrecruiters.com/v1/companies/{board}/postings",
            params={"limit": 100, "offset": offset},
        )
        resp.raise_for_status()
        payload = resp.json()
        batch = payload.get("content") or []
        for item in batch:
            title = item.get("name") or ""
            if not is_relevant_listing(title):
                continue
            loc = item.get("location") or {}
            loc_str = loc.get("fullLocation") or loc.get("city") or ""
            job_id = item.get("id") or item.get("uuid")
            ad = item.get("jobAd") or {}
            desc_parts: list[str] = []
            if isinstance(ad, dict):
                sections = ad.get("sections") or {}
                if isinstance(sections, dict):
                    for section in sections.values():
                        if isinstance(section, dict):
                            desc_parts.append(str(section.get("text") or ""))
            desc = strip_html(" ".join(desc_parts))
            jobs.append(
                Job(
                    id=f"smartrecruiters-{board}-{job_id}",
                    source=f"SmartRecruiters · {company}",
                    title=title,
                    company=company,
                    url=f"https://jobs.smartrecruiters.com/{board}/{job_id}",
                    location=str(loc_str),
                    description=desc,
                    posted_at=_parse_date(item.get("releasedDate")),
                    remote=bool(loc.get("remote")) or "remote" in str(loc_str).lower(),
                )
            )
        offset += len(batch)
        if not batch or offset >= int(payload.get("totalFound") or 0):
            break
    return jobs


def collect_board_jobs() -> tuple[list[Job], list[str]]:
    """Fetch every slug in `data/company-boards.yaml`. Dead slugs become warnings."""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    config = load_boards()
    tasks: dict[str, object] = {}
    for row in config.get("greenhouse") or []:
        name, board = row["name"], row["board"]
        tasks[f"Greenhouse:{name}"] = lambda n=name, b=board: fetch_greenhouse(n, b)
    for row in config.get("lever") or []:
        name, board = row["name"], row["board"]
        tasks[f"Lever:{name}"] = lambda n=name, b=board: fetch_lever(n, b)
    for row in config.get("ashby") or []:
        name, board = row["name"], row["board"]
        tasks[f"Ashby:{name}"] = lambda n=name, b=board: fetch_ashby(n, b)
    for row in config.get("recruitee") or []:
        name, board = row["name"], row["board"]
        tasks[f"Recruitee:{name}"] = lambda n=name, b=board: fetch_recruitee(n, b)
    for row in config.get("smartrecruiters") or []:
        name, board = row["name"], row["board"]
        tasks[f"SmartRecruiters:{name}"] = lambda n=name, b=board: fetch_smartrecruiters(n, b)
    for url in config.get("wwr_feeds") or []:
        tasks[f"WWR:{url}"] = lambda u=url: fetch_wwr(u)
    for url in config.get("berlin_feeds") or []:
        tasks[f"Berlin Startup Jobs:{url}"] = lambda u=url: fetch_berlin_rss(u)

    collected: list[Job] = []
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=24) as pool:
        future_map = {pool.submit(fn): name for name, fn in tasks.items()}
        for future in as_completed(future_map):
            name = future_map[future]
            try:
                collected.extend(future.result())
            except Exception as exc:
                errors.append(f"{name}: {exc}")
    return collected, errors
