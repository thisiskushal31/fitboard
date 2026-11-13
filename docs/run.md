# Run Fitboard

Docker Desktop on a Mac or Windows, or Docker Engine with Compose on Linux. About 2 GB of free memory.

## On this machine, for development

From this repository:

```bash
cp config/env.example .env
docker compose build
docker/bin/yarn hash-password
```

Put the printed `argon2id:` line in `.env` as `FITBOARD_PASSWORD`, and set `FITBOARD_SECRET` to the output of `openssl rand -base64 32`. Then:

```bash
docker compose up
```

Open http://localhost:3001. Containers are `fitboard-dev-app-1` / `fitboard-dev-db-1`. The source is mounted into the container, so edits reload. Yarn and the database run in containers, not on the host. The longer notes are in [development.md](development.md).

The first database is empty apart from the built-in resume themes. To load the sample person (Jane Doe) and the sample applications:

```bash
docker/bin/yarn prisma db seed -- --demo
```

That does not import a résumé from a file. Replace Jane Doe in the Profile screen when the app is yours.

## Production and development on the same machine

One folder. Two stacks (`name: fitboard` vs `name: fitboard-dev`). Full cheat sheet: [development.md — Production and development on one machine](development.md#production-and-development-on-one-machine).

```bash
# Production → http://localhost:3000  (fitboard-app-1 / fitboard-db-1)
# On Apple Silicon include compose.amd64.yml:
docker compose -f compose.production.yml -f compose.amd64.yml pull app
docker compose -f compose.production.yml -f compose.amd64.yml up -d

# Development → http://localhost:3001  (fitboard-dev-app-1 / fitboard-dev-db-1)
docker compose -f compose.yml up --build

# Stop one stack without wiping its database (never add -v unless you mean it):
docker compose -f compose.production.yml down
docker compose -f compose.yml down
```

| Stack | URL | Containers | Postgres volume (do not delete) |
| --- | --- | --- | --- |
| Production | http://localhost:3000 | `fitboard-app-1`, `fitboard-db-1` | `fitboard_pgdata` |
| Development | http://localhost:3001 | `fitboard-dev-app-1`, `fitboard-dev-db-1` | `fitboard-dev_pgdata` |

## On a server

`compose.production.yml` is the VM file. It pulls an image, it does not build one. Next to a `.env` with `POSTGRES_PASSWORD`, `FITBOARD_PASSWORD`, and `FITBOARD_SECRET`:

```bash
docker compose -f compose.production.yml up -d
```

The app listens on `127.0.0.1:3000`. Containers are `fitboard-app-1` / `fitboard-db-1`. Put HTTPS in front of it. Give the machine at least 2 vCPUs and 2 GB of memory. Chromium, which prints the PDFs, needs most of that.

Password hash, if you do not already have one:

```bash
docker run --rm -it --platform linux/amd64 ghcr.io/thisiskushal31/fitboard hash-password
```

On an Apple Silicon Mac the published image is Intel. Pass `compose.amd64.yml` with production (do **not** put that in `compose.override.yml`, or every local `docker compose up` would emulate amd64 too):

```bash
docker compose -f compose.production.yml -f compose.amd64.yml pull app
docker compose -f compose.production.yml -f compose.amd64.yml up -d --no-deps --force-recreate app
```
