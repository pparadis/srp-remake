# Backend Deploy on Render

Minimal setup for hosting the backend API on Render.

## Service Setup (Docker, recommended)

The backend bundles the shared game engine from `src/game` and the track data from
`public/tracks`, so the Docker build context must be the **repo root**, not `backend/`.

- Create a new **Web Service** from this repo, runtime **Docker**.
- **Root Directory**: leave empty.
- **Dockerfile Path**: `backend/Dockerfile`
- **Docker Build Context Directory**: `.`

A context of `backend/` (for example from setting Root Directory to `backend`) fails with
`"/public/tracks": not found` / `"/src/game": not found`. Render injects `PORT`; the server
reads it, and listens on `HOST` (default `0.0.0.0`).

Check an image locally the same way Render builds it:

```bash
podman build -f backend/Dockerfile -t srp-api .
podman run --rm -e PORT=10000 -p 10000:10000 srp-api   # curl localhost:10000/health
```

## Service Setup (Node runtime, alternative)

- **Root Directory**: empty (repo root). Runtime: `Node`.
- **Build Command**

```bash
npm --prefix backend ci --include=dev && npm --prefix backend run build
```

`--include=dev` is required: Render sets `NODE_ENV=production`, which makes `npm ci` skip
devDependencies, but the build needs `typescript` and `esbuild`. Without it the build fails
with `tsc: not found`.

- **Start Command**

```bash
npm --prefix backend run start
```

## Required Environment Variables

- `HOST=0.0.0.0`
- `CORS_ALLOWED_ORIGINS=<frontend origin(s)>`
- `PLAYER_TOKEN_TTL_SECONDS=86400`

Example `CORS_ALLOWED_ORIGINS`:

```text
https://your-frontend.example.com,http://localhost:5173
```

Optional, with their defaults:

- `LOBBY_IDLE_SECONDS=3600`: a lobby with no open socket is dropped after this long without activity (a finished
  one after 10 minutes). A lobby with a connected player is never dropped.
- `MAX_LOBBIES=1000`: creating a lobby over this answers `503 Server is full`. A backstop for the rate limit.
- `RATE_LIMIT_ENABLED=true`: per-IP, per-minute limits (lobby create 10, join 30, reads, WebSocket and turn/host
  actions 240). Over the limit answers `429` with `Retry-After`. Counters live in memory, which is right for one
  instance; several instances would need a shared store (Redis).
- `TRUST_PROXY=false`: `true` (or a hop count) makes the server take the client address from `X-Forwarded-For`.
- `DATABASE_URL`: the race history (#170). Absent, the history lives in memory and is gone at a restart (fine for
  development). With a Postgres URL the server keeps every finished online race, and the solo races their players
  upload, in one table `races` (created on first use). See "Race history (Neon)" below.

## Race history (Neon)

The history is anonymous and append-only: one row per race, holding the race log (a few KB, under 1 KB gzipped) and
nothing that identifies a player (the names and the player ids are not kept). It runs on a free Neon Postgres project:

1. The Neon project is set up with the Neon CLI (`neon.ts` at the root, `.neon` for the linked project and branch, both
   from `neon init`; `.neon` and `.env.local` are not committed). `neon login` (or `NEON_API_KEY` for a key) and then
   `neon deploy` pull the branch's variables into `.env.local`: `DATABASE_URL` (the **pooled** URL, for the app's
   queries) and `DATABASE_URL_UNPOOLED` (the **direct** URL, used only to create the table).
2. In the Render service, set `DATABASE_URL` and `DATABASE_URL_UNPOOLED` to the **production** branch's values
   (`neon env pull` on that branch, or the Neon console), and redeploy.
3. Check: `GET /api/v1/races` answers `{ "races": [] }`; after a finished online race it lists it.

Locally, `npm --prefix backend run dev` loads `../.env.local` when it exists, so the backend then talks to the checked-out
Neon branch. Use a **dev branch** for that (`neon checkout dev --create`: it expires after 7 days, per `neon.ts`), not
`production`. The tests and the e2e do not load it: they use the in-memory store.

The driver is node-postgres (`pg`): the backend is one long-running Node server that keeps its pool, which is the case
Neon's guidance gives `pg` for (the serverless driver is for runtimes that cannot keep a connection). `pg` currently treats
`sslmode=require` as `verify-full` and prints a warning about the change planned for pg 9; use `sslmode=verify-full` in the
URL to say what is meant.

Neon suspends the database after 5 minutes without a query, so the first write after a quiet spell takes a few
seconds; the server never waits for it (an online race is stored after its end, and a failure only loses that entry).
`POST /api/v1/races` (a solo upload) answers `503` while the database cannot be reached. The store is behind the
`RaceStore` interface (`backend/src/race_store.ts`), so another database can replace Neon.

- `POST /api/v1/races` `{ trackId?, log }`: the server **replays the log with the engine** and keeps it only if every
  action is legal and the race has a winner (`400` otherwise, `413` over 128 KB). Same race twice: `200 { duplicate }`.
  10 a minute per IP.
- `GET /api/v1/races?limit=` (newest first, up to 100) and `GET /api/v1/races/:id` (the whole log).

## Security notes

- A player token is a bearer secret: whoever has it plays that seat until it expires (`PLAYER_TOKEN_TTL_SECONDS`,
  24 h) or the lobby ends. It travels in the URL of the lobby read and the WebSocket, so the request log replaces
  `playerToken=` values with `[redacted]`. App log lines carry a short fingerprint instead.
- Set `CORS_ALLOWED_ORIGINS` to the frontend origin in production. The default `*` is for local development
  (CORS is not an auth boundary here, but there is no reason to leave it open).
- Inputs are bounded: names 32 characters, request bodies 16 KiB, WebSocket frames 1 KiB.

### TRUST_PROXY on Render

Render puts a proxy in front of the service, so without `TRUST_PROXY` every request comes from the proxy's address
and shares one rate-limit bucket: the first busy minute would lock every player out. Set `TRUST_PROXY=true` on
Render, then check in the logs (`remoteAddress` of a request) that it is the client's address and not a Render
internal one (10.x). If it is the proxy's, use a hop count (`TRUST_PROXY=2`) instead.

Never set it where the backend is reachable directly (the docker-compose stack): a client could then send a fake
`X-Forwarded-For` to dodge the limit.

## Health Check

- Set health check path to:

```text
/health
```

`/health` answers `{ ok, lobbies, sha }`; `sha` is the commit the server runs, which the web page shows next to its own
(bottom right on the home and lobby screens, amber when they differ). The server takes it from `GIT_SHA`, else from
`RENDER_GIT_COMMIT` (Render sets it on every deploy, nothing to configure), else from `git rev-parse HEAD`, else `unknown`.

## Quick Verify

After deploy:

```bash
curl https://<your-render-service>/health
```

Expected:

```json
{ "ok": true, "lobbies": 0 }
```

## Frontend (GitHub Pages)

`.github/workflows/deploy-pages.yml` builds the frontend with `VITE_BACKEND_API_BASE_URL`
pointing at the Render service (`https://srp-remake.onrender.com`). The WebSocket URL is
derived from it. Without this the deployed site falls back to `http://localhost:3001` and
online lobbies cannot connect. Change the URL there if the service is renamed.

### Hosting and PR previews (#96)

Pages serves the `gh-pages` branch (Settings > Pages > Source: "Deploy from a branch", `gh-pages`, `/ (root)`).
`deploy-pages.yml` pushes production to the branch root on every push to `main` and keeps `pr-preview/`;
`pr-preview.yml` builds each same-repo PR with `VITE_BASE_PATH=/srp-remake/pr-preview/pr-N/`, publishes it to
`pr-preview/pr-N/`, comments the link on the PR and removes the folder when the PR closes. Forks get no preview.

- A preview plays solo as is. Online play uses the production backend (same origin, so CORS passes); backend changes
  in a PR are not previewed.
- The version label reads `web <sha> · PR #N` (from `VITE_PREVIEW_PR`); amber against the production server is expected.
- A reload inside a preview stays in it: `tools/make404.mjs` (the `postbuild` step) puts a small script in the root
  `404.html` that loads the preview's own `index.html` for a `/pr-preview/pr-N/...` path.
- Previews are public, like the repo.
