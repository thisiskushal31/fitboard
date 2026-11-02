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

Open http://localhost:3000. The source is mounted into the container, so edits reload. Yarn and the database run in containers, not on the host. The longer notes are in [development.md](development.md).

The first database is empty apart from the built-in resume themes. To load the sample person (Jane Doe) and the sample applications:

```bash
docker/bin/yarn prisma db seed -- --demo
```

That does not import a résumé from a file. Replace Jane Doe in the Profile screen when the app is yours.

## On a server

`compose.production.yml` is the VM file. It pulls an image, it does not build one. Next to a `.env` with `POSTGRES_PASSWORD`, `FITBOARD_PASSWORD`, and `FITBOARD_SECRET`:

```bash
docker compose -f compose.production.yml up -d
```

The app listens on `127.0.0.1:3000`. Put HTTPS in front of it. Give the machine at least 2 vCPUs and 2 GB of memory. Chromium, which prints the PDFs, needs most of that.

Password hash, if you do not already have one:

```bash
docker run --rm -it --platform linux/amd64 ghcr.io/thisiskushal31/fitboard hash-password
```

On an Apple Silicon Mac the published image is Intel, so the override below lets Docker Desktop emulate it:

```bash
printf 'services:\n  app:\n    platform: linux/amd64\n' > compose.override.yml
```
