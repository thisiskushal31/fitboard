# Fitboard

Fitboard is a job search you run yourself. One profile in Postgres, a resume and cover letter that only use facts from that profile, and a board of applications from draft to offer.

The parts that are specific to this repo:

- **Public boards.** Greenhouse, Lever, Ashby, Recruitee, SmartRecruiters, plus Remotive, RemoteOK, Arbeitnow, We Work Remotely, Berlin Startup Jobs, MyCareersFuture, Hacker News, and Codeforces. The company list covers APAC, JAPAC, EMEA, MEA, and the Americas. Employers with no public API are links on the Career path screen.
- **Other sources, kept separate.** Boardsearch, Adzuna, FreeHire, and the German federal board. Pick one source at a time in Settings.
- **A read next to the fit score.** Suited, stretch, or not suited, and the skills to add. Those skills stay off the resume until you have them. A generic Software Engineer title can still qualify when the skills match.
- **Region rank.** Remote, then APAC, JAPAC, EMEA, MEA, Nordics, and the Americas.
- **Career path.** Current, next, destination, and trending titles, scored against the live crawl.

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

## More

- [How to run it](docs/run.md)
- [Working on the code](docs/development.md)
- [Contributing](docs/contributing.md)
- [Privacy](docs/privacy.md)
- [Security](docs/security.md)

<a name="known-limitations"></a>

Desktop browser, one password, one profile, English interface. Run one copy of the app per database.

## License

[GNU Affero General Public License v3.0](LICENSE). If you run a changed version for other people over a network, you offer them the source.
