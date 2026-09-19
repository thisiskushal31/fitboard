from __future__ import annotations

import json
import os
import textwrap

import requests

from .boards import official_careers
from .career import build_career_report, extra_search_queries, load_career_config, render_career_markdown, report_to_dict
from .jobs import collect_jobs
from .match import ScoredJob, rank_jobs
from .profile import Profile
from .trends import market_trends

USER_AGENT = "Fitboard/1.0 (personal job search; +https://github.com/thisiskushal31)"


def _job_payload(item: ScoredJob) -> dict:
    return {
        "score": item.score,
        "fit": item.fit,
        "fit_summary": item.fit_summary,
        "title": item.job.title,
        "company": item.job.company,
        "source": item.job.source,
        "location": item.job.location,
        "url": item.job.url,
        "role": item.matched_role,
        "clouds": item.matched_clouds,
        "regions": item.regions,
        "cloud_fit": item.cloud_fit,
        "skills": item.matched_skills[:8],
        "missing_skills": item.missing_skills[:8],
        "gap_plan": item.gap_plan[:8],
        "reasons": item.reasons,
    }


def _llm_brief(profile: Profile, ranked: list[ScoredJob], trends: dict, career: dict) -> str | None:
    suited = [item for item in ranked if item.fit == "suited"]
    stretch = [item for item in ranked if item.fit == "stretch"]
    not_suited = [item for item in ranked if item.fit == "not_suited"]
    payload = {
        "suited": [_job_payload(item) for item in suited[:12]],
        "stretch": [_job_payload(item) for item in stretch[:8]],
        "not_suited": [_job_payload(item) for item in not_suited[:8]],
    }
    prompt = textwrap.dedent(
        f"""
        You are a job-search agent for {profile.name}, a {profile.headline}
        with {profile.years_experience}+ years. Narrative: architect and operate
        production platforms (not a past job title).
        Target roles (title is optional — skills can qualify): {", ".join(profile.target_roles)}.
        Core skills: {", ".join(profile.core_skills)}.
        Confident clouds: {", ".join(profile.confident_clouds)}.
        Other clouds that also work: {", ".join(profile.also_ok_clouds)}.

        Match on skills even when the title is Software Engineer / SDE / backend
        rather than Cloud / SRE / Platform. AWS and GCP are confident; Azure and
        the other named clouds are acceptable with a transfer plan.
        Global means Remote, India, Singapore, UK, Middle East, Germany, Nordics, EMEA, APAC, US, and Americas.
        Rank India first after remote, then Singapore, then UK. Do not invent LinkedIn or LeetCode scrapes; those are official links only.
        X roles come from xAI Greenhouse. Codeforces hiring comes from their public API.

        Companies fire without notice. Lead with the career path: current roles (plural), next roles, trending titles, destination roles, and skill gaps from this crawl. Do not tell the user the market is fine.

        Write a concise briefing:

        0. Career path first — what to learn next and why boards asked for it.
        1. This week's apply list (5 suited jobs) — why each fits, in one line.
        2. Stretch roles — what is close and what to add.
        3. Not suited — for each, say exactly:
           "I am not suited, but this is what you need to get suited here:"
           then the gap_plan items (skills, cloud names, seniority). Do not hide these.
        4. What the market is repeating (roles, skills, clouds, remote).
        5. How to talk about architecture without claiming an Architect title.

        Listings JSON:
        {json.dumps(payload, indent=2)[:12000]}

        Career path JSON (this is first: current role, next roles, trending title, destination, skill gaps from boards):
        {json.dumps(career, indent=2)[:4000]}

        Trends JSON:
        {json.dumps({k: trends[k] for k in ("job_count", "skill_demand", "you_have", "gaps", "role_titles", "remote_share") if k in trends}, indent=2)[:4000]}
        """
    ).strip()

    gemini_key = os.getenv("GEMINI_API_KEY")
    if gemini_key:
        resp = requests.post(
            "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent",
            params={"key": gemini_key},
            headers={"User-Agent": USER_AGENT},
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()["candidates"][0]["content"]["parts"][0]["text"]

    openai_key = os.getenv("OPENAI_API_KEY")
    if openai_key:
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {openai_key}", "User-Agent": USER_AGENT},
            json={
                "model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.3,
            },
            timeout=60,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    return None


def _bucket_lines(items: list[ScoredJob], heading: str) -> list[str]:
    lines = ["", f"### {heading}"]
    if not items:
        lines.append("- None in this crawl.")
        return lines
    for item in items:
        job = item.job
        extra = item.fit_summary
        lines.append(
            f"- **{job.title}** at {job.company} ({item.score:.0f}) — {extra} {job.url}"
        )
    return lines


def _heuristic_brief(profile: Profile, ranked: list[ScoredJob], trends: dict, path_md: str = "") -> str:
    suited = [item for item in ranked if item.fit == "suited"][:5]
    stretch = [item for item in ranked if item.fit == "stretch"][:5]
    not_suited = [item for item in ranked if item.fit == "not_suited"][:5]
    lines = []
    if path_md:
        lines += [path_md, "", "---", ""]
    lines += [
        f"## Agent briefing for {profile.name}",
        "",
        "Public boards only (Greenhouse, Lever, Ashby, RemoteOK, We Work Remotely, Remotive, HN, Codeforces API, xAI/X Greenhouse, MyCareersFuture, Agentur für Arbeit, Berlin Startup Jobs). LinkedIn, X timelines, and LeetCode HTML are not scraped.",
        f"Roles: Software Engineer, Cloud Engineer, SRE, Platform Engineer — titles optional; skills and clouds also qualify.",
        f"Regions (India first after remote): {', '.join(profile.wanted_regions)}. US listings stay in the list but score lower.",
        f"Confident clouds: {', '.join(profile.confident_clouds)}. Also works: Azure and the handbook set.",
    ]
    lines += _bucket_lines(suited, "Apply this week (suited)")
    lines += _bucket_lines(stretch, "Stretch")
    lines += _bucket_lines(not_suited, "Not suited — gap plan")
    lines += ["", "### Market snapshot", f"- Listings scanned: {trends.get('job_count')}"]
    if trends.get("remote_share") is not None:
        lines.append(f"- Remote share in this batch: {trends['remote_share']}%")
    if trends.get("role_titles"):
        lines.append("- Title tokens: " + ", ".join(f"{n} ({c})" for n, c in trends["role_titles"][:6]))
    if trends.get("you_have"):
        lines.append("- Skills you already have that are repeating: " + ", ".join(n for n, _ in trends["you_have"][:8]))
    if trends.get("gaps"):
        lines.append("- Showing up, thinner on profile: " + ", ".join(n for n, _ in trends["gaps"][:8]))
    lines += [
        "",
        "### Official career sites (no public ATS API)",
        "Google, Meta, Amazon, Apple, Microsoft, NVIDIA, Salesforce, banks, and India IT majors are not crawled. Open these yourself:",
    ]
    for row in official_careers():
        name, url = row.get("name"), row.get("url")
        if name and url:
            lines.append(f"- [{name}]({url})")
    lines += [
        "",
        "### Architecture narrative",
        "Keep 'architect and operate' — design the platform shape, then own it in production. Do not say Architect at Purplle.",
        "",
        "Set GEMINI_API_KEY or OPENAI_API_KEY for a written agent brief on top of this list.",
    ]
    return "\n".join(lines)


def run_agent(profile: Profile) -> dict:
    cfg = load_career_config()
    queries = list(dict.fromkeys(list(profile.search_queries) + extra_search_queries(cfg)))
    jobs, errors = collect_jobs(queries)
    ranked = rank_jobs(jobs, profile, limit=80)
    trends = market_trends(jobs, profile)
    path = build_career_report(jobs, profile, cfg)
    path_md = render_career_markdown(path)
    brief = _heuristic_brief(profile, ranked, trends, path_md)
    llm_error = None
    try:
        llm = _llm_brief(profile, ranked, trends, report_to_dict(path))
        if llm:
            brief = path_md + "\n\n" + llm
    except Exception as exc:
        llm_error = str(exc)
        errors = list(errors) + [f"LLM: {exc}"]
    return {
        "jobs": jobs,
        "ranked": ranked,
        "trends": trends,
        "errors": errors,
        "brief": brief,
        "llm_error": llm_error,
        "used_llm": llm_error is None and bool(os.getenv("GEMINI_API_KEY") or os.getenv("OPENAI_API_KEY")),
    }
