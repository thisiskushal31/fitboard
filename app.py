"""Fitboard Streamlit UI.

Loads the candidate profile, crawls public boards (cached for 30 minutes),
and scores listings into suited / stretch / not-suited buckets. LLM briefing
is off unless the sidebar toggle is on. Streamlit Cloud secrets are copied
into the process environment so Adzuna keys work without a local `.env`.
"""

from __future__ import annotations

import os
import sys
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))


def _load_dotenv() -> None:
    """Read KEY=VALUE lines from `.env` without overriding existing env vars."""
    path = ROOT / ".env"
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


_load_dotenv()

import pandas as pd
import streamlit as st


def _export_streamlit_secrets() -> None:
    """Copy Streamlit Cloud secrets into os.environ for the rest of the stack."""
    try:
        for key, value in st.secrets.items():
            if isinstance(value, str) and value:
                os.environ.setdefault(key, value)
    except Exception:
        return


_export_streamlit_secrets()

from src.agent import run_agent
from src.boards import load_boards, official_careers
from src.career import (
    build_career_report,
    extra_search_queries,
    load_career_config,
    render_career_markdown,
)
from src.jobs import collect_jobs
from src.llm import active_provider, default_llm_toggle, has_llm_key
from src.match import rank_jobs
from src.profile import load_profile
from src.trends import market_trends

st.set_page_config(page_title="Fitboard", page_icon="📋", layout="wide")

PROFILE = load_profile()
CAREER = load_career_config()
SEARCH_QUERIES = tuple(dict.fromkeys(list(PROFILE.search_queries) + extra_search_queries(CAREER)))


def _show_role_cards(roles) -> None:
    """Render one career-path role: closeness, next move, and live skill gaps."""
    for role in roles:
        with st.container(border=True):
            st.markdown(f"**{role.name}** — {role.closeness}")
            st.caption(f"Layers: {', '.join(role.layers)} · {role.listing_count} listings")
            st.write(f"Do next: {role.next_move}")
            if role.kind == "current" and role.have:
                st.markdown(
                    "Keep hot: `"
                    + "` · `".join(f"{g.skill} ({g.mentions})" for g in role.have[:6])
                    + "`"
                )
            for gap in role.lacking[:5]:
                st.write(f"- {gap.why}")
            if role.kind != "current" and not role.lacking:
                st.write("Boards in this crawl are not asking for skills you lack on this track.")


@st.cache_data(ttl=30 * 60, show_spinner=False)
def load_market(queries: tuple[str, ...]):
    """Crawl, score, and summarise. Cache key is the search-query tuple."""
    jobs, errors = collect_jobs(list(queries))
    ranked = rank_jobs(jobs, PROFILE)
    trends = market_trends(jobs, PROFILE)
    path = build_career_report(jobs, PROFILE, CAREER)
    return jobs, ranked, trends, errors, path


def main() -> None:
    st.title("Fitboard")
    st.caption(
        f"{PROFILE.name} · current: {', '.join(CAREER.current_roles)} · "
        f"next: {', '.join(CAREER.next_roles)} · destination: {', '.join(CAREER.destination_roles)}"
    )

    with st.sidebar:
        st.header("Search")
        min_score = st.slider("Minimum match score", 10, 90, 35)
        only_remote = st.checkbox("Remote-friendly only", value=False)
        max_age = st.select_slider(
            "Posted within",
            options=[7, 14, 30, 90, 365],
            value=30,
            format_func=lambda d: f"{d} days",
        )
        show_fits = st.multiselect(
            "Fit",
            ["suited", "stretch", "not_suited"],
            default=["suited", "stretch", "not_suited"],
            format_func=lambda v: {
                "suited": "Suited",
                "stretch": "Stretch",
                "not_suited": "Not suited (gap plan)",
            }[v],
        )
        show_regions = st.multiselect(
            "Regions",
            PROFILE.wanted_regions,
            default=PROFILE.wanted_regions,
        )
        if st.button("Refresh jobs", use_container_width=True):
            load_market.clear()
            st.rerun()
        st.divider()
        st.markdown("**LLM enhancement**")
        use_llm = st.toggle("Enhance briefing with LLM", value=default_llm_toggle())
        if use_llm:
            provider = active_provider()
            if provider:
                st.caption(f"Using {provider}. Keys stay in `.env`, not git.")
            else:
                st.caption("Toggle is on, but no API key is set. Add ANTHROPIC_API_KEY, OPENAI_API_KEY, or GEMINI_API_KEY to `.env`.")
        else:
            st.caption("Off by default. Crawl, match, and career path still run.")
        st.divider()
        st.markdown("**Career path**")
        st.write("Now: " + ", ".join(CAREER.current_roles))
        st.write("Next: " + ", ".join(CAREER.next_roles))
        st.write("Destination: " + ", ".join(CAREER.destination_roles))
        if CAREER.trending:
            st.write("Trending: " + ", ".join(CAREER.trending))
        st.caption("Every list in `data/career-path.yaml` accepts multiple roles. Add a line, then refresh.")
        st.markdown("**Target roles (matching)**")
        st.write(", ".join(CAREER.all_target_roles))
        st.caption("Titles are optional. Skills and clouds can qualify a Software Engineer / SDE listing.")
        st.markdown("**Regions**")
        st.write(", ".join(PROFILE.wanted_regions))
        st.markdown("**Confident clouds**")
        st.write(", ".join(PROFILE.confident_clouds))
        st.markdown("**Other clouds that also work**")
        st.write(", ".join(PROFILE.also_ok_clouds[:8]) + ", …")
        st.markdown("**Core skills**")
        st.write(", ".join(PROFILE.core_skills[:12]))
        st.caption("Edit `data/profile.yaml` and `data/company-boards.yaml` when targets change.")
        st.caption(
            "LinkedIn / Instahyre / LeetCode HTML / X timelines are not scraped. "
            "X roles come from the xAI Greenhouse board. Codeforces hiring posts come from their public API. "
            "Singapore jobs also come from MyCareersFuture. Germany jobs also come from Agentur für Arbeit and Berlin Startup Jobs. "
            "First crawl hits hundreds of company boards and can take a few minutes."
        )

    with st.spinner("Pulling live jobs and scoring them against the profile…"):
        jobs, ranked, trends, errors, path = load_market(SEARCH_QUERIES)

    filtered = []
    for item in ranked:
        if item.fit not in show_fits:
            continue
        if show_regions and item.regions and not any(region in show_regions for region in item.regions):
            continue
        if item.score < min_score and item.fit != "not_suited":
            continue
        if only_remote and not (item.job.remote or "remote" in item.job.haystack):
            continue
        if item.job.posted_at:
            try:
                age = (date.today() - datetime.strptime(item.job.posted_at[:10], "%Y-%m-%d").date()).days
                if age > max_age:
                    continue
            except ValueError:
                pass
        filtered.append(item)

    suited_n = sum(1 for item in filtered if item.fit == "suited")
    stretch_n = sum(1 for item in filtered if item.fit == "stretch")
    gap_n = sum(1 for item in filtered if item.fit == "not_suited")
    k1, k2, k3, k4 = st.columns(4)
    k1.metric("Listings scanned", trends["job_count"])
    k2.metric("Suited / stretch", f"{suited_n} / {stretch_n}")
    k3.metric("Not suited (gap plan)", gap_n)
    k4.metric("Remote share", f"{trends['remote_share']}%" if trends["remote_share"] is not None else "n/a")

    path_tab, matches_tab, agent_tab, trends_tab, profile_tab = st.tabs(
        ["Career path", "Matched jobs", "Agent briefing", "Market trends", "Profile used"]
    )

    with path_tab:
        st.warning(path.stance)
        st.caption(f"Generated {path.generated_on} · {path.job_count} listings. Edit data/career-path.yaml then refresh.")
        st.subheader("Current roles")
        _show_role_cards(path.current)
        st.subheader("Next roles")
        _show_role_cards(path.next_roles)
        if path.trending:
            st.subheader("Trending — keep in line")
            _show_role_cards(path.trending)
        st.subheader("Destination roles")
        _show_role_cards(path.destination)
        st.subheader("Checks this crawl")
        if not path.checks:
            st.write("No new gaps in this batch. Keep shipping the current next-move.")
        for gap in path.checks:
            st.error(gap.why) if gap.mentions else st.info(gap.why)
        with st.expander("Full markdown (also written by CLI)"):
            st.markdown(render_career_markdown(path))

    with matches_tab:
        if errors:
            with st.expander(f"{len(errors)} source warning(s)"):
                for err in errors:
                    st.write(err)
        if not filtered:
            st.info("No matches at this score. Lower the threshold or refresh.")
        for item in filtered:
            job = item.job
            header = f"{item.score:.0f} · {item.fit.replace('_', ' ')} · {job.title} · {job.company}"
            with st.container(border=True):
                st.markdown(f"**{header}**")
                meta = " · ".join(
                    part
                    for part in (job.source, job.location or "Location n/a", job.posted_at or "date n/a", job.salary)
                    if part
                )
                st.caption(meta)
                if item.fit == "not_suited":
                    st.warning(item.fit_summary)
                elif item.fit == "stretch":
                    st.info(item.fit_summary)
                else:
                    st.write(item.fit_summary)
                st.write(" · ".join(item.reasons) or "Role or skill overlap with the profile.")
                if item.matched_skills:
                    st.markdown("Matched skills: `" + "` · `".join(item.matched_skills[:10]) + "`")
                if item.matched_clouds:
                    st.markdown("Clouds: `" + "` · `".join(item.matched_clouds) + f"` ({item.cloud_fit})")
                if item.regions:
                    st.markdown("Regions: `" + "` · `".join(item.regions) + "`")
                if item.gap_plan and item.fit != "suited":
                    st.markdown("To get suited: `" + "` · `".join(item.gap_plan[:8]) + "`")
                if job.url:
                    st.link_button("Open listing", job.url)
                with st.expander("Full description"):
                    text = (job.description or "").strip()
                    if text:
                        st.markdown(text)
                    else:
                        st.caption("This board did not publish a description on the public API.")

    with agent_tab:
        st.subheader("Job-search agent")
        st.write(
            "Runs the public-board crawl, scores listings against roles, skills, and clouds, then writes a briefing. "
            "Not-suited jobs stay on the list with: I am not suited, but this is what you need to get suited here. "
            "LLM is off unless the sidebar toggle is on. Without it, the apply list and career path still run."
        )
        if st.button("Run agent", type="primary"):
            with st.spinner("Writing a briefing from the public-board crawl…"):
                report = run_agent(
                    PROFILE,
                    use_llm=use_llm,
                    jobs=jobs,
                    ranked=ranked,
                    trends=trends,
                    errors=errors,
                )
            st.session_state["agent_report"] = report
        report = st.session_state.get("agent_report")
        if report:
            if report.get("used_llm"):
                st.caption(f"LLM enhancement: {report.get('llm_provider')}")
            else:
                st.caption("Heuristic briefing — LLM was not called.")
            st.markdown(report["brief"])
            if report.get("errors"):
                with st.expander(f"{len(report['errors'])} warning(s)"):
                    for err in report["errors"]:
                        st.write(err)
        else:
            st.info("Click Run agent for this week's apply list and market read.")

    with trends_tab:
        st.subheader("Skills the market is repeating")
        st.caption("Counted across the live listings just pulled — not a global salary survey.")
        if trends["skill_demand"]:
            demand_df = pd.DataFrame(trends["skill_demand"], columns=["skill", "mentions"]).set_index("skill")
            st.bar_chart(demand_df)
        cols = st.columns(2)
        with cols[0]:
            st.markdown("**Already on the profile**")
            if trends["you_have"]:
                st.dataframe(
                    pd.DataFrame(trends["you_have"], columns=["skill", "mentions"]),
                    hide_index=True,
                    use_container_width=True,
                )
            else:
                st.write("None of the top tokens matched the profile skills.")
        with cols[1]:
            st.markdown("**Showing up, thinner on the profile**")
            if trends["gaps"]:
                st.dataframe(
                    pd.DataFrame(trends["gaps"], columns=["skill", "mentions"]),
                    hide_index=True,
                    use_container_width=True,
                )
            else:
                st.write("No obvious gaps in this batch.")
        st.subheader("Role wording in titles")
        if trends["role_titles"]:
            st.bar_chart(pd.DataFrame(trends["role_titles"], columns=["token", "count"]).set_index("token"))
        if trends.get("regions"):
            st.subheader("Regions in this batch")
            st.bar_chart(pd.DataFrame(trends["regions"], columns=["region", "count"]).set_index("region"))
        st.caption("Sources: " + ", ".join(f"{name} ({count})" for name, count in trends["sources"]))

    with profile_tab:
        st.markdown(f"**{PROFILE.name}**  \n{PROFILE.headline}")
        st.write(f"Experience: {PROFILE.years_experience}+ years · Base location: {PROFILE.location}")
        st.write("Open to: " + ", ".join(PROFILE.open_to))
        st.markdown("**Regions**")
        st.write(", ".join(PROFILE.wanted_regions))
        st.markdown("**Target roles**")
        st.write(", ".join(PROFILE.target_roles))
        st.caption("A listing does not need these exact titles. Skills and clouds can qualify it.")
        st.markdown("**Confident clouds**")
        st.write(", ".join(PROFILE.confident_clouds))
        st.markdown("**Other clouds that also work**")
        st.write(", ".join(PROFILE.also_ok_clouds))
        st.markdown("**Core skills**")
        st.write(", ".join(PROFILE.core_skills))
        st.markdown("**Supporting skills**")
        st.write(", ".join(PROFILE.supporting_skills))
        boards = load_boards()
        st.markdown("**Company boards crawled**")
        st.caption(
            f"{len(boards.get('greenhouse') or [])} Greenhouse · "
            f"{len(boards.get('lever') or [])} Lever · "
            f"{len(boards.get('ashby') or [])} Ashby"
        )
        st.markdown("**Official career sites (open in a browser — no public JSON API)**")
        for row in official_careers():
            name, url = row.get("name"), row.get("url")
            if name and url:
                st.markdown(f"- [{name}]({url})")
        st.info(
            "Public sources only: Remotive, RemoteOK, Arbeitnow, HN Who is Hiring, We Work Remotely RSS, "
            "Codeforces public API, xAI Greenhouse (X jobs), and company career APIs (Greenhouse, Lever, Ashby). "
            "LinkedIn Jobs, LeetCode, Instahyre, Naukri, and Indeed are not scraped — open the official links above. "
            "Google / Meta / Amazon / Apple / Microsoft live under official career sites above."
        )


if __name__ == "__main__":
    main()
