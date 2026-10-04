# Backend Local Stack

Containerized local multiplayer backend stack.

## Stack

- `Node.js 24` + `TypeScript`
- `Fastify` + `@fastify/websocket`
- Shares the game engine (`src/game/race`) and track data with the browser; `npm run backend:build` bundles them with esbuild, and the container is built from the repo root.
- In-memory lobby state and `clientCommandId` dedupe (lost on restart)
- `Podman + Podman Compose` orchestration (primary)

## Prerequisites

- Install container tooling (Ubuntu/WSL):

```bash
sudo apt update
sudo apt install -y podman podman-compose uidmap
```

## Services

- `api` (`localhost:3001`)

## API Env Vars

- `HOST` (default `0.0.0.0`)
- `PORT` (default `3001`)
- `CORS_ALLOWED_ORIGINS` (default `*`)
  - Use comma-separated origins for stricter production setup.
  - Example: `https://your-frontend.example.com,http://localhost:5173`
- `PLAYER_TOKEN_TTL_SECONDS` (default `86400`)
  - Player tokens expire after this duration.

## Run

Without containers (no Podman/Docker needed), from the repo root:

```bash
npm --prefix backend ci
npm --prefix backend run dev   # API + WebSocket on http://localhost:3001, reloads on change
```

With containers (Podman, rootless):

1. Build and start (the first build takes a minute; wait for `(healthy)` in `podman ps`):

```bash
npm run backend:up
```

2. Stop:

```bash
npm run backend:down
```

Restart quickly:

```bash
npm run backend:restart
```

3. Logs:

```bash
npm run backend:logs
```

4. API contract tests:

```bash
npm --prefix backend test
```

## Container Notes

- The image is built from the repo root (`docker-compose.yml` sets the context) so it can bundle the shared
  game engine; it uses `npm ci` (lockfile-exact) and a multi-stage build (~180 MB).
- It runs as the non-root `node` user, with `node` as PID 1 and a `/health` healthcheck (`podman ps` shows
  `(healthy)`). The server shuts down cleanly on SIGTERM, so `podman stop` takes ~2 s.
- Rootless Podman prints a harmless `"/" is not a shared mount` warning.

## Docker Instead of Podman

The scripts use `podman-compose`. With Docker, run the same commands
directly, e.g. `docker compose up --build api` / `docker compose down`.

## Health Check

```bash
curl http://localhost:3001/health
```

Expected shape:

```json
{
  "ok": true,
  "lobbies": 0
}
```

## Minimal API Surface (Scaffold)

- `POST /api/v1/lobbies`
- `GET /api/v1/lobbies/:lobbyId?playerToken=...`
- `POST /api/v1/lobbies/:lobbyId/join`
- `PATCH /api/v1/lobbies/:lobbyId/settings`
- `POST /api/v1/lobbies/:lobbyId/start`
- `POST /api/v1/lobbies/:lobbyId/turns`
- `GET /ws` (websocket with `lobbyId` + `playerToken` query)

- Render deployment guide: `docs/backend-render-deploy.md`

## Notes

- Lobbies and races live in memory only; restarting the backend ends them.
- The turn route checks, in order: token, `revision`, active seat, then the game rules (shared race engine).
  A refused turn is a `409` with `{ ok: false, error, reason? }`; `error` is one of `stale_revision`,
  `lobby_not_in_race`, `not_active_player` or `invalid_action` (with the engine's `reason`, e.g.
  `invalid_target`, `moves_available`, `not_pit_box`, `invalid_setup`). Refusals are deduped by
  `clientCommandId` like successes. A malformed payload is a `400`.
- Turn actions: `{ type: "move", targetCellId }`, `{ type: "pit", targetCellId, setup }`, `{ type: "skip" }`.

## Multiplayer Logging

- Backend emits structured `multiplayer_event` logs with:
  - `event`, `lobbyId`, `playerId`, `seatIndex`, `revision`, `turnIndex`, `clientCommandId`, `wsConnId`.
- Token values are never logged directly.
  - Logs include `tokenFingerprint` (short hash) when needed.
- Frontend emits structured console logs under `[multiplayer]` for:
  - API lifecycle (`host/join/start/turn submit`)
  - websocket lifecycle (`ws connecting/open/close/reconnect`)
  - rehydrate lifecycle (`rehydrate start/success/fail`)

## Local Client Smoke Test

1. Start backend stack:

```bash
npm run backend:up
```

2. Start frontend:

```bash
npm run dev
```

Optional (if not using default):

```bash
VITE_BACKEND_API_BASE_URL=http://localhost:3001 npm run dev
```

3. Open two browser tabs on the frontend URL.
4. In tab A, set the number of humans to 2, then click `Host local lobby` and copy the `Lobby ID` (or the invite link).
5. In tab B, paste the same `Lobby ID` and click `Join lobby`.
6. In tab A, click `Start race` (a human seat nobody joined is played by a bot).
7. Drag your car on your turn. The move is sent to the server, validated, and both tabs redraw from the
   server's state; bots play on the server. Status updates are shown in `Backend: ...` text.

## Troubleshooting

- Podman reports container name already in use:

```bash
podman rm -f srp-remake_api_1
npm run backend:up
```

- Browser works on `localhost` but tooling fails on `127.0.0.1`:
  - Use `http://localhost:3001` consistently for frontend and tooling on WSL setups.

- Frontend CORS errors:
  - Confirm backend exposes `CORS_ALLOWED_ORIGINS` for your frontend origin.
  - Example: `CORS_ALLOWED_ORIGINS=https://your-frontend.example.com,http://localhost:5173`
