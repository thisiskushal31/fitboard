<div align="center">

<img src="src/app/icon.svg" alt="Fitboard" width="80" height="80" />

# Fitboard

### A job search you run yourself.

**One profile in Postgres, a resume and cover letter that only use facts from that profile, and a board of applications from draft to offer.**

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg?style=flat-square)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-run-0A66C2?style=flat-square)](docs/run.md)
[![Buy Me a Coffee](https://img.shields.io/badge/Buy%20Me%20a%20Coffee-FFDD00?style=flat-square&logo=buy-me-a-coffee&logoColor=black)](https://buymeacoffee.com/thisiskushal)

**[Run](docs/run.md) · [Development](docs/development.md) · [Contributing](docs/contributing.md) · [Privacy](docs/privacy.md) · [Security](docs/security.md)**

[Public boards](#public-boards) · [Other sources](#other-sources) · [Where the files are](#where-the-files-are) · [Known limitations](#known-limitations)

</div>

---

These parts are specific to this repository.

## Public boards

Greenhouse, Lever, Ashby, Recruitee, SmartRecruiters, plus Remotive, RemoteOK, Arbeitnow, We Work Remotely, Berlin Startup Jobs, MyCareersFuture, Hacker News, and Codeforces. The company list covers APAC, JAPAC, EMEA, MEA, and the Americas. Employers with no public API are links on the Career path screen.

## Other sources

Boardsearch, Adzuna, FreeHire, and the German federal board stay separate. Pick one source at a time in Settings.

## The fit score

A read next to the fit score: suited, stretch, or not suited, and the skills to add. Those skills stay off the resume until you have them. A generic Software Engineer title can still qualify when the skills match.

## Region rank

Remote, then APAC, JAPAC, EMEA, MEA, Nordics, and the Americas.

## Career path

Current, next, destination, and trending titles, scored against the live crawl.

## The starting profile

The starting profile is the demo person, Jane Doe. That is sample data for the screens and the tests. Your own profile is what you type in the app after you sign in. Nothing is loaded from a YAML file.

## Run

Docker Compose, PostgreSQL, one password. The steps are in [docs/run.md](docs/run.md). On a VM, `compose.production.yml` pulls the image and passes `FITBOARD_PASSWORD` and `FITBOARD_SECRET`.

Open http://localhost:3000 after it starts.

## Where the files are

| Path | What it is |
| --- | --- |
| `src/app` | Screens and route handlers |
| `src/lib` | Server logic, in folders such as `applications`, `documents`, `profile`, `postings`, `settings`, `core`, `ai`, `job-search`, `scoring`, and `career` |
| `src/components` | Shared interface pieces |
| `prisma` | Database schema and the demo seed |
| `docker` | Container start scripts |
| `config` | Lint, test, Playwright, the env example, and `job-boards.json` (companies and shared boards) |
| `docs` | How to run it, build it, and the privacy and security notes |
| `e2e` | Browser tests |

`package.json`, `yarn.lock`, `compose.yml`, `compose.production.yml`, `Dockerfile`, and `LICENSE` stay at the root. Next.js only reads `next.config.ts` and `tsconfig.json` from that same folder, and Prisma only reads `prisma.config.ts` from there, so those stay beside `package.json`.

## Docs

| Guide | Link |
| --- | --- |
| How to run it | [docs/run.md](docs/run.md) |
| Working on the code | [docs/development.md](docs/development.md) |
| Contributing | [docs/contributing.md](docs/contributing.md) |
| Privacy | [docs/privacy.md](docs/privacy.md) |
| Security | [docs/security.md](docs/security.md) |

## Known limitations

Desktop browser, one password, one profile, English interface. Run one copy of the app per database.

## Buy me a coffee

Fitboard stays free and self-hosted. If it is useful to you and you want to help keep it going, [buy me a coffee](https://buymeacoffee.com/thisiskushal). A small one is plenty. Thank you for being here.

## License

[GNU Affero General Public License v3.0](LICENSE). If you run a changed version for other people over a network, you offer them the source.
