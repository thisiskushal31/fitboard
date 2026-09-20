# Fitboard

Fitboard is a Streamlit job-search agent. It crawls **public** career boards, scores listings against a Software Engineer / Cloud / SRE / Platform profile, and produces a briefing: apply list, stretch roles, and not-suited gap plans.

Matching is skill-led. A listing can qualify on skills and clouds even when the title is a generic Software Engineer or SDE role. The app also keeps a company-independent career path — current roles, next roles, destination roles, and skills this crawl asked for that the profile still lacks.

## What it crawls

Public APIs and RSS feeds that companies publish on purpose:

- Remotive, RemoteOK, Arbeitnow, Hacker News Who is Hiring
- We Work Remotely RSS (DevOps / programming)
- Berlin Startup Jobs RSS
- Singapore MyCareersFuture
- Germany Agentur für Arbeit Jobbörse
- Codeforces public API (`recentActions`, hiring posts only)
- xAI Greenhouse (X / Twitter roles — `careers.x.com` redirects here)
- Greenhouse, Lever, Ashby, Recruitee, and SmartRecruiters boards listed in `data/company-boards.yaml`
- Optional [Adzuna](https://developer.adzuna.com/) if `ADZUNA_APP_ID` and `ADZUNA_APP_KEY` are set

`data/company-boards.yaml` already includes a large Greenhouse / Lever / Ashby set (global product companies, India fintech and SaaS, and unicorns that publish those boards), plus `official_careers` links for employers with no public JSON API (Google, Meta, Amazon, Apple, Microsoft, banks, and others).

Add a company by appending its **career-site slug** — the token in `boards.greenhouse.io/<slug>`, `jobs.lever.co/<slug>`, or `jobs.ashbyhq.com/<slug>`. Dead slugs show as warnings, not a crash.

This is not every employer. Shops that only post on LinkedIn or Naukri, or that have no public ATS, will not appear until they publish a crawlable board.

## What it does not crawl

**LinkedIn, Instahyre, Naukri, Indeed, X timelines, and LeetCode HTML are not scraped.** Those sites forbid unofficial scraping or they block non-browser clients. Fitboard does not collect logins, cookies, or session tokens.

Those names are handled as follows:

- **X jobs** — xAI Greenhouse public board (`xai`)
- **Codeforces** — documented public API, hiring posts only
- **LinkedIn Jobs** and **LeetCode** — official links to open in a browser
- **Naukri** — used only as a company-name source when mapping public boards; the site itself is not scraped

## Regions

Listings are tagged and ranked:

1. Remote
2. India
3. Singapore
4. UK
5. Middle East
6. Germany
7. Nordics / rest of Europe (EMEA)
8. APAC
9. US
10. Americas

US listings stay in the list and rank last among those regions. With Adzuna keys set, Fitboard queries GB, SG, DE, IN, IE, NL, FR, AT, IT, PL, BE, ES, CH, AU, NZ, and US. Other EU employment sites (France Travail, Werk.nl, AMS, JobsIreland, EURES, and similar) are listed under `official_careers` to open in a browser.

## Career path

The first tab is a company-independent path, not an employer promise. Edit `data/career-path.yaml` — `current_roles`, `next_roles`, `destination_roles`, and `trending` all accept multiple titles — then refresh the app or run:

```bash
python -m src.career --json
```

That writes `out/career-path.md` (and `out/career-path.json` with `--json`). Each run reports skills the live crawl asked for that the profile still lacks.

## Run locally

Python 3.12 is pinned in `.python-version`.

```bash
python3.12 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
streamlit run app.py
```

Open http://localhost:8501. Crawl, match, career path, and the apply list run with **no LLM**. Turn on **Enhance briefing with LLM** in the sidebar only when a written brief from Claude, OpenAI, or Gemini is wanted.

Copy `.env.example` to `.env` and set **one** LLM API key if that toggle will be used. Keys are ignored while the toggle is off. Optional Adzuna keys widen aggregator coverage and are not LLM.

| Key | Who it is for |
| --- | --- |
| `ANTHROPIC_API_KEY` | Claude, from [console.anthropic.com](https://console.anthropic.com/) |
| `OPENAI_API_KEY` | OpenAI, from [platform.openai.com](https://platform.openai.com/) |
| `GEMINI_API_KEY` | Gemini, from [Google AI Studio](https://aistudio.google.com/) |
| `CURSOR_API_KEY` + `CURSOR_BASE_URL` | Only with an OpenAI-compatible gateway in front of Cursor |

**A Cursor IDE subscription, Claude.ai Pro, or ChatGPT Plus is not an API key.** Those plans run chat inside the product. Fitboard needs a developer key from the tables above. Cursor's official API is Cloud Agents (repo workflows), not `chat/completions`.

If several keys are set, Fitboard uses Cursor (when a gateway URL is present), then Claude, then OpenAI, then Gemini. Set `LLM_PROVIDER=anthropic|openai|gemini|cursor` to force one. `FITBOARD_ENABLE_LLM=true` turns the sidebar toggle on by default; the LLM still is not called until **Run agent** runs with the toggle on.

Do not commit `.env`.

## Deploy (free): Streamlit Community Cloud

1. Push this repository to GitHub.
2. Open [share.streamlit.io](https://share.streamlit.io), sign in with GitHub, **Create app**.
3. Main file: `app.py`. Branch: `main`.
4. App settings → **Secrets** — paste only keys that are in use:

```toml
ANTHROPIC_API_KEY = "your-key"
OPENAI_API_KEY = "your-key"
GEMINI_API_KEY = "your-key"
ADZUNA_APP_ID = "your-id"
ADZUNA_APP_KEY = "your-key"
```

5. Deploy. The URL looks like `https://<account>-fitboard.streamlit.app`.

The first crawl hits hundreds of boards and can take a few minutes. The free app sleeps when idle; the next visit is a cold start. The URL is public, so treat API keys as rotatable and skip them if strangers should not trigger the LLM.

[Hugging Face Spaces](https://huggingface.co/docs/hub/spaces-sdks-docker) is the other free option (Docker, existing `Dockerfile`, can be private).

## Deploy on Cloud Run

Requires a GCP billing account.

```bash
gcloud run deploy fitboard \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars PORT=8080
```

Pass LLM keys with `--set-env-vars` if they are used. Do not commit `.env`.

## Configuration

| File | Purpose |
| --- | --- |
| `data/profile.yaml` | Name, roles, skills, clouds, region preference, search queries |
| `data/career-path.yaml` | Current / next / destination / trending titles |
| `data/company-boards.yaml` | ATS slugs and official career URLs |

AWS and GCP are treated as confident clouds. Azure and the other named clouds (Oracle, IBM, Alibaba, Tencent, Huawei, OVH, Open Telekom, CtrlS, Yotta, Linode, DigitalOcean, Cloudflare) still match, with a transfer note. If a listing is not a fit, the UI and agent keep it with a gap plan: **I am not suited, but this is what you need to get suited here.**

## Layout

```
app.py                 Streamlit UI
src/agent.py           Briefing (heuristic + optional LLM)
src/llm.py             Claude / OpenAI / Gemini / optional Cursor gateway
src/jobs.py            Aggregators and public job APIs
src/boards.py          Greenhouse, Lever, Ashby, Recruitee, SmartRecruiters, RSS
src/match.py           Skill / role / region scoring
src/career.py          Career-path report
src/profile.py         Profile loader
src/regions.py         Region tags and rank weights
src/trends.py          Skill demand in the current crawl
data/                  YAML config
tests/                 Unit tests
```

```bash
python -m unittest discover -s tests
```
