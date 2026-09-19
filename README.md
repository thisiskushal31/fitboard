# Fitboard

A Streamlit job-search **agent**: crawls **public** career boards, scores listings against your Software Engineer / Cloud / SRE / Platform profile (skills and clouds, not just titles), and writes a briefing (apply list + stretch + not-suited gap plans).

## What it will not do

**LinkedIn, Instahyre, Naukri, Indeed, X timelines, and LeetCode HTML are not scraped.** Those sites forbid unofficial scraping or they block non-browser clients (LeetCode jobs returns 403). I will not build a LinkedIn crawler or a LeetCode/X HTML scraper.

What *is* crawled for those names:

- **X jobs** — xAI Greenhouse public board (`xai`). X hiring moved there; `careers.x.com` redirects.
- **Codeforces** — documented public API `recentActions`, hiring posts only. There is no Codeforces jobs board.

**LinkedIn Jobs** and **LeetCode** are listed as official links to open yourself (India, US, UK, Singapore/APAC, Germany, UAE, EMEA). There is no unofficial scrape.

Global search covers **Remote, India, Singapore, UK, Middle East, Germany, Nordics, EMEA, APAC, US, and Americas**. Rank: Remote → India → Singapore → UK → Middle East → Germany → rest of Europe (including Nordics) → APAC → US → Americas. US listings stay in the list and rank last among those regions.

With Adzuna keys set, Fitboard queries GB, SG, DE, IN, IE, NL, FR, AT, IT, PL, BE, ES, CH, AU, NZ, and US. Singapore’s **MyCareersFuture** and Germany’s **Agentur für Arbeit** public APIs are crawled directly. Other EU country employment sites are listed under official_careers to open yourself (France Travail, Werk.nl, AMS, JobsIreland, Cliclavoro, Praca.gov.pl, SEPE, VDAB, IEFP, Arbetsförmedlingen, Jobnet, EURES, UK Find a job).

The agent instead hits APIs and RSS feeds companies publish on purpose:

- Remotive, RemoteOK, Arbeitnow, HN Who is Hiring
- We Work Remotely RSS (DevOps / programming)
- Berlin Startup Jobs RSS
- Singapore MyCareersFuture
- Germany Agentur für Arbeit Jobbörse
- Codeforces public API (hiring blog posts)
- xAI Greenhouse (X / Twitter roles)
- Greenhouse, Lever, Ashby, Recruitee, and SmartRecruiters job-board APIs for companies in `data/company-boards.yaml`
- Optional Adzuna if you set keys

Add more companies by appending their **career-site slug** to `company-boards.yaml` (the token in `boards.greenhouse.io/<slug>`, `jobs.lever.co/<slug>`, or `jobs.ashbyhq.com/<slug>`).

`data/company-boards.yaml` already includes:

- Global names that publish Greenhouse / Lever / Ashby (Stripe, Databricks, SpaceX, OpenAI, Anthropic, Cursor, CRED, Razorpay, Zomato, Thoughtworks, UiPath, Deliveroo, Wise, Monzo, …)
- A large India ATS set (fintech, consumer internet, SaaS, deep tech, AI ops)
- Unicorn coverage: every company on Inc42’s India unicorn tracker, plus CB Insights global unicorns that publish Greenhouse / Lever / Ashby
- Names taken from Naukri’s India hiring list (especially Software Product) then mapped to public boards or official career URLs
- `official_careers` for giants and unicorns with **no** public JSON board: Google, Meta, Amazon, Apple, Microsoft, ByteDance, Revolut, Zerodha, Pine Labs, DBS, OCBC, UOB, ARM, DeepMind, Darktrace, Sea, Standard Chartered, …

This is **not** every employer in those markets. Shops that only post on LinkedIn/Naukri, or that have no public ATS, will not appear until they publish a crawlable board.

Naukri itself is **not scraped**. The listing is only a company-name source.

Those official URLs are listed in the **Profile used** tab and in the agent briefing. They are not crawled.

## Career path (this is first)

Companies fire without notice. Fitboard leads with a company-independent path: current role, next roles, a trending title you can change in a minute, and skills this crawl asked for that you still lack.

Edit `data/career-path.yaml` (current_roles / next_roles / destination_roles / trending — every list accepts multiple titles), then:

```bash
cd /Users/kushalgupta/Documents/Personal_Project/fitboard
.venv/bin/python -m src.career --json
```

That writes `out/career-path.md` (and `out/career-path.json` with `--json`). The Streamlit app shows the same report on the **Career path** tab, first.

## Run locally

If Streamlit is already running, stop it (Ctrl+C) and start again so this code loads.

```bash
cd /Users/kushalgupta/Documents/Personal_Project/fitboard
.venv/bin/streamlit run app.py
```

Open http://localhost:8501 → **Agent briefing** → **Run agent**.

## Make it an LLM agent

Copy `.env.example` to `.env` and set **one** of:

- `GEMINI_API_KEY` (Gemini 2.0 Flash)
- `OPENAI_API_KEY`

Without a key, Run agent still returns a scored apply list from the public crawl.

## Deploy (free): Streamlit Community Cloud

This is the $0 path. Cloud Run needs a GCP billing account even if usage stays in the free tier.

1. Put `fitboard/` on GitHub (public repo is enough for the free plan).
2. Open [share.streamlit.io](https://share.streamlit.io), sign in with GitHub, **Create app**.
3. Repository: that repo. Branch: `main`. Main file: `app.py`.
4. App settings → Secrets — paste only what you use (do not commit `.env`):

```toml
GEMINI_API_KEY = "your-key"
ADZUNA_APP_ID = "your-id"
ADZUNA_APP_KEY = "your-key"
```

5. Deploy. URL looks like `https://<you>-fitboard.streamlit.app`.

The first crawl hits hundreds of boards and can take a few minutes. The free app sleeps when idle; the next open is a cold start. The URL is public, so treat API keys as burnable and skip keys if you do not want strangers triggering Gemini.

Hugging Face Spaces is the other free option (Docker, existing `Dockerfile`, can be private). Cloud Run is below if you already have GCP billing.

## Deploy on Cloud Run

Needs a GCP billing account. Not a free platform.

```bash
cd /Users/kushalgupta/Documents/Personal_Project/fitboard
gcloud run deploy fitboard \
  --source . \
  --region asia-south1 \
  --allow-unauthenticated \
  --set-env-vars PORT=8080
```

Pass LLM keys with `--set-env-vars` if you use them. Do not commit `.env`.

## Tune

- Career path (multiple current / next / destination / trending titles): `data/career-path.yaml`
- Profile / roles / skills / clouds: `data/profile.yaml` (keep aligned with `thisiskushal31/ai-data/career-info.md` and `Deep-Dives/DevOps-Handbook/Cloud/`)
- Company ATS list: `data/company-boards.yaml`

Matching keeps **Software Engineer**, **Cloud Engineer**, **SRE**, and **Platform Engineer**, and also keeps listings whose **skills** match even when the title is not on that list. AWS and GCP are confident clouds; Azure and the handbook set (OCI, IBM, Alibaba, Tencent, Huawei, OVH, OTC, CtrlS/Yotta, Linode, DigitalOcean, Cloudflare) also work. If a role is not a fit, the UI and agent say **I am not suited, but this is what you need to get suited here** plus the gap plan.

Some board slugs 404 when a company moved ATS. That shows up as a warning, not a crash.
