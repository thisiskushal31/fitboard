"""Public job aggregators and country APIs. ATS boards live in `boards.py`."""

from __future__ import annotations

import html
import os
import re
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

import requests

from .regions import ADZUNA_COUNTRIES

USER_AGENT = "Fitboard/1.0 (public ATS job search)"
TIMEOUT = 20

TAG_RE = re.compile(r"<[^>]+>")
SPACE_RE = re.compile(r"\s+")


def strip_html(value: str | None) -> str:
    if not value:
        return ""
    text = TAG_RE.sub(" ", html.unescape(value))
    return SPACE_RE.sub(" ", text).strip()


@dataclass
class Job:
    """One listing from a public board. `haystack` is the lowercase search blob."""
    id: str
    source: str
    title: str
    company: str
    url: str
    location: str = ""
    description: str = ""
    tags: list[str] = field(default_factory=list)
    posted_at: str = ""
    remote: bool | None = None
    salary: str = ""

    @property
    def haystack(self) -> str:
        parts = [self.title, self.company, self.location, self.description, " ".join(self.tags)]
        return " ".join(parts).lower()


def _get(url: str, **kwargs: Any) -> requests.Response:
    headers = kwargs.pop("headers", {})
    headers.setdefault("User-Agent", USER_AGENT)
    headers.setdefault("Accept", "application/json")
    return requests.get(url, timeout=TIMEOUT, headers=headers, **kwargs)


def _parse_date(value: Any) -> str:
    if not value:
        return ""
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(int(value), tz=timezone.utc).date().isoformat()
        except (OSError, ValueError, OverflowError):
            return ""
    text = str(value).replace("Z", "")
    try:
        from email.utils import parsedate_to_datetime

        parsed = parsedate_to_datetime(str(value))
        if parsed:
            return parsed.date().isoformat()
    except (TypeError, ValueError, OverflowError):
        pass
    for size, fmt in ((19, "%Y-%m-%dT%H:%M:%S"), (19, "%Y-%m-%d %H:%M:%S"), (10, "%Y-%m-%d")):
        try:
            return datetime.strptime(text[:size], fmt).date().isoformat()
        except ValueError:
            continue
    return text[:10] if text[:10].count("-") == 2 else ""


CF_HIRING_HINTS = (
    "hiring",
    "we're hiring",
    "we are hiring",
    "job opening",
    "vacancies",
    "recruiting",
    "looking to hire",
)


def codeforces_jobs_from_payload(payload: dict) -> list[Job]:
    jobs: list[Job] = []
    seen: set[str] = set()
    for item in payload.get("result") or []:
        entry = item.get("blogEntry") or {}
        comment = item.get("comment") or {}
        title = strip_html(entry.get("title") or "")
        text = strip_html(comment.get("text") or "")
        tags = [str(t) for t in (entry.get("tags") or [])]
        blob = f"{title} {text} {' '.join(tags)}".lower()
        if not any(hint in blob for hint in CF_HIRING_HINTS):
            continue
        blog_id = entry.get("id")
        if not blog_id or str(blog_id) in seen:
            continue
        seen.add(str(blog_id))
        jobs.append(
            Job(
                id=f"codeforces-{blog_id}",
                source="Codeforces",
                title=title or f"Codeforces hiring post #{blog_id}",
                company=entry.get("authorHandle") or "Codeforces",
                url=f"https://codeforces.com/blog/entry/{blog_id}",
                location="See post",
                description=(text or title)[:4000],
                tags=tags,
                posted_at=_parse_date(entry.get("creationTimeSeconds")),
                remote="remote" in blob,
            )
        )
    return jobs


def fetch_codeforces_hiring() -> list[Job]:
    """Codeforces `recentActions` API — hiring blog posts only, not the full feed."""
    resp = _get("https://codeforces.com/api/recentActions", params={"maxCount": 100})
    resp.raise_for_status()
    payload = resp.json()
    if payload.get("status") != "OK":
        raise RuntimeError(payload.get("comment") or "Codeforces API error")
    return codeforces_jobs_from_payload(payload)


def fetch_remotive(query: str) -> list[Job]:
    resp = _get("https://remotive.com/api/remote-jobs", params={"search": query, "limit": 50})
    resp.raise_for_status()
    jobs: list[Job] = []
    for item in resp.json().get("jobs", []):
        jobs.append(
            Job(
                id=f"remotive-{item.get('id')}",
                source="Remotive",
                title=item.get("title") or "",
                company=item.get("company_name") or "",
                url=item.get("url") or item.get("short_url") or "",
                location=item.get("candidate_required_location") or "Remote",
                description=strip_html(item.get("description")),
                tags=list(item.get("tags") or []),
                posted_at=_parse_date(item.get("publication_date")),
                remote=True,
                salary=item.get("salary") or "",
            )
        )
    return jobs


def fetch_remoteok() -> list[Job]:
    resp = _get("https://remoteok.com/api")
    resp.raise_for_status()
    payload = resp.json()
    jobs: list[Job] = []
    for item in payload:
        if not isinstance(item, dict) or not item.get("position"):
            continue
        jobs.append(
            Job(
                id=f"remoteok-{item.get('id') or item.get('slug')}",
                source="RemoteOK",
                title=item.get("position") or "",
                company=item.get("company") or "",
                url=item.get("url") or item.get("apply_url") or "",
                location=item.get("location") or "Remote",
                description=strip_html(item.get("description")),
                tags=[str(t) for t in (item.get("tags") or [])],
                posted_at=_parse_date(item.get("date") or item.get("epoch")),
                remote=True,
                salary=str(item.get("salary_max") or item.get("salary_min") or ""),
            )
        )
    return jobs


def fetch_arbeitnow() -> list[Job]:
    resp = _get("https://www.arbeitnow.com/api/job-board-api")
    resp.raise_for_status()
    jobs: list[Job] = []
    for item in resp.json().get("data", []):
        jobs.append(
            Job(
                id=f"arbeitnow-{item.get('slug')}",
                source="Arbeitnow",
                title=item.get("title") or "",
                company=item.get("company_name") or "",
                url=item.get("url") or "",
                location=item.get("location") or "",
                description=strip_html(item.get("description")),
                tags=list(item.get("tags") or []) + list(item.get("job_types") or []),
                posted_at=_parse_date(item.get("created_at")),
                remote=bool(item.get("remote")),
            )
        )
    return jobs


def fetch_adzuna(query: str, country: str) -> list[Job]:
    """Optional Adzuna search. No-ops when ADZUNA_APP_ID / ADZUNA_APP_KEY are unset."""
    app_id = os.getenv("ADZUNA_APP_ID")
    app_key = os.getenv("ADZUNA_APP_KEY")
    if not app_id or not app_key:
        return []
    resp = _get(
        f"https://api.adzuna.com/v1/api/jobs/{country}/search/1",
        params={
            "app_id": app_id,
            "app_key": app_key,
            "what": query,
            "results_per_page": 30,
            "content-type": "application/json",
        },
    )
    resp.raise_for_status()
    jobs: list[Job] = []
    for item in resp.json().get("results", []):
        loc = item.get("location", {}) or {}
        salary = ""
        if item.get("salary_min") or item.get("salary_max"):
            salary = f"{item.get('salary_min', '')}-{item.get('salary_max', '')} {item.get('salary_currency', '')}".strip()
        jobs.append(
            Job(
                id=f"adzuna-{item.get('id')}",
                source=f"Adzuna ({country.upper()})",
                title=item.get("title") or "",
                company=(item.get("company") or {}).get("display_name") or "",
                url=item.get("redirect_url") or "",
                location=loc.get("display_name") or "",
                description=strip_html(item.get("description")),
                posted_at=_parse_date(item.get("created")),
                remote="remote" in (item.get("title") or "").lower(),
                salary=salary,
            )
        )
    return jobs


def jobs_from_mycareersfuture(payload: dict) -> list[Job]:
    from .boards import is_relevant_listing

    jobs: list[Job] = []
    for item in payload.get("results") or []:
        title = item.get("title") or ""
        desc = strip_html(item.get("description") or item.get("otherRequirements"))
        if not is_relevant_listing(title, desc):
            continue
        posted = item.get("postedCompany") or {}
        hiring = item.get("hiringCompany") or {}
        company = posted.get("name") or hiring.get("name") or "Singapore employer"
        meta = item.get("metadata") or {}
        url = meta.get("jobDetailsUrl") or ""
        uuid = item.get("uuid") or meta.get("jobPostId") or url
        addr = item.get("address") or {}
        loc_bits: list[str] = []
        if addr.get("overseasCountry"):
            loc_bits.append(str(addr["overseasCountry"]))
        districts = addr.get("districts") or []
        if districts and isinstance(districts[0], dict):
            loc_bits.append(str(districts[0].get("location") or ""))
        loc_bits.append("Singapore")
        location = ", ".join(dict.fromkeys(bit for bit in loc_bits if bit))
        salary_obj = item.get("salary") or {}
        salary = ""
        if salary_obj.get("minimum") or salary_obj.get("maximum"):
            salary = f"{salary_obj.get('minimum', '')}-{salary_obj.get('maximum', '')} SGD"
        tags: list[str] = []
        for skill in item.get("skills") or []:
            if isinstance(skill, dict):
                tags.append(str(skill.get("skill") or skill.get("name") or ""))
            elif skill:
                tags.append(str(skill))
        blob = f"{title} {desc} {location}"
        jobs.append(
            Job(
                id=f"mcf-{uuid}",
                source="MyCareersFuture (SG)",
                title=title,
                company=company,
                url=url,
                location=location,
                description=desc[:4000],
                tags=[t for t in tags if t],
                posted_at=_parse_date(meta.get("newPostingDate") or meta.get("createdAt")),
                remote="remote" in blob.lower() or "work from home" in blob.lower(),
                salary=salary,
            )
        )
    return jobs


def fetch_mycareersfuture(query: str) -> list[Job]:
    resp = _get(
        "https://api.mycareersfuture.gov.sg/v2/jobs",
        params={"search": query, "limit": 20},
    )
    resp.raise_for_status()
    return jobs_from_mycareersfuture(resp.json())


def jobs_from_arbeitsagentur(payload: dict) -> list[Job]:
    from .boards import is_relevant_listing

    jobs: list[Job] = []
    for item in payload.get("ergebnisliste") or []:
        title = item.get("stellenangebotsTitel") or item.get("hauptberuf") or ""
        company = item.get("firma") or "Germany employer"
        ref = str(item.get("referenznummer") or "")
        url = item.get("externeURL") or (
            f"https://www.arbeitsagentur.de/jobsuche/jobdetail/{ref}" if ref else ""
        )
        cities: list[str] = []
        for loc in item.get("stellenlokationen") or []:
            addr = (loc or {}).get("adresse") or {}
            city = addr.get("ort") or ""
            if city:
                cities.append(str(city))
        location = ", ".join(dict.fromkeys(cities))
        if location and "germany" not in location.lower() and "deutschland" not in location.lower():
            location = f"{location}, Germany"
        elif not location:
            location = "Germany"
        blob = f"{title} {company} {location}"
        if not is_relevant_listing(title, blob):
            continue
        salary = ""
        if item.get("gehaltsspanneVon") or item.get("gehaltsspanneBis"):
            salary = f"{item.get('gehaltsspanneVon', '')}-{item.get('gehaltsspanneBis', '')} EUR"
        jobs.append(
            Job(
                id=f"de-ba-{ref or title}",
                source="Agentur für Arbeit (DE)",
                title=title,
                company=company,
                url=url,
                location=location,
                description=blob,
                posted_at=_parse_date(
                    item.get("datumErsteVeroeffentlichung")
                    or (item.get("veroeffentlichungszeitraum") or {}).get("von")
                ),
                remote=bool(item.get("homeofficemoeglich")) or "homeoffice" in blob.lower(),
                salary=salary,
            )
        )
    return jobs


def fetch_arbeitsagentur(query: str) -> list[Job]:
    resp = _get(
        "https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs",
        params={"was": query, "size": 25},
        headers={"X-API-Key": "jobboerse-jobsuche"},
    )
    resp.raise_for_status()
    return jobs_from_arbeitsagentur(resp.json())


def fetch_hn_who_is_hiring() -> list[Job]:
    search = _get(
        "https://hn.algolia.com/api/v1/search",
        params={"query": "Ask HN: Who is hiring?", "tags": "story", "hitsPerPage": 1},
    )
    search.raise_for_status()
    hits = search.json().get("hits") or []
    if not hits:
        return []
    story_id = hits[0].get("objectID")
    comments = _get(
        "https://hn.algolia.com/api/v1/search_by_date",
        params={"tags": f"comment,story_{story_id}", "hitsPerPage": 80},
    )
    comments.raise_for_status()
    jobs: list[Job] = []
    for item in comments.json().get("hits", []):
        text = strip_html(item.get("comment_text"))
        if not text or len(text) < 80:
            continue
        first_line = text.split("\n", 1)[0][:140]
        jobs.append(
            Job(
                id=f"hn-{item.get('objectID')}",
                source="HN Who is Hiring",
                title=first_line,
                company="Hacker News thread",
                url=f"https://news.ycombinator.com/item?id={item.get('objectID')}",
                location="See post",
                description=text[:4000],
                posted_at=_parse_date(item.get("created_at")),
                remote="remote" in text.lower(),
            )
        )
    return jobs


def collect_jobs(queries: list[str]) -> tuple[list[Job], list[str]]:
    """Fan out aggregator + ATS fetches. Source failures become warnings, not crashes."""
    tasks: dict[str, Any] = {
        "RemoteOK": fetch_remoteok,
        "Arbeitnow": fetch_arbeitnow,
        "HN Who is Hiring": fetch_hn_who_is_hiring,
        "Codeforces": fetch_codeforces_hiring,
    }
    for query in queries[:8]:
        tasks[f"Remotive:{query}"] = lambda q=query: fetch_remotive(q)
        tasks[f"MyCareersFuture:{query}"] = lambda q=query: fetch_mycareersfuture(q)
        tasks[f"Agentur für Arbeit:{query}"] = lambda q=query: fetch_arbeitsagentur(q)
    if os.getenv("ADZUNA_APP_ID") and os.getenv("ADZUNA_APP_KEY"):
        for query in queries[:6]:
            for country in ADZUNA_COUNTRIES:
                tasks[f"Adzuna:{country}:{query}"] = lambda q=query, c=country: fetch_adzuna(q, c)

    collected: list[Job] = []
    errors: list[str] = []
    with ThreadPoolExecutor(max_workers=12) as pool:
        future_map = {pool.submit(fn): name for name, fn in tasks.items()}
        for future in as_completed(future_map):
            name = future_map[future]
            try:
                collected.extend(future.result())
            except Exception as exc:  # network / API failures should not kill the app
                errors.append(f"{name}: {exc}")

    try:
        from .boards import collect_board_jobs

        board_jobs, board_errors = collect_board_jobs()
        collected.extend(board_jobs)
        errors.extend(board_errors)
    except Exception as exc:
        errors.append(f"ATS boards: {exc}")

    seen: set[str] = set()
    unique: list[Job] = []
    for job in collected:
        key = job.url or job.id
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(job)
    return unique, errors
