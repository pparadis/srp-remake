# Backend Local Stack

Containerized local multiplayer backend stack.

## Stack

- `Node.js 20` + `TypeScript`
- `Fastify` + `@fastify/websocket`
- `Redis` for dedupe cache (`clientCommandId`)
- `Podman + Podman Compose` orchestration (primary)

## Prerequisites

- Install container tooling (Ubuntu/WSL):

```bash
sudo apt update
sudo apt install -y podman podman-compose
```

## Services

- `api` (`localhost:3001`)
- `redis` (`localhost:6379`)

## API Env Vars

- `HOST` (default `0.0.0.0`)
- `PORT` (default `3001`)
- `REDIS_URL` (default `redis://redis:6379`)
- `DEDUPE_TTL_SECONDS` (default `3600`)
- `CORS_ALLOWED_ORIGINS` (default `*`)
  - Use comma-separated origins for stricter production setup.
  - Example: `https://your-frontend.example.com,http://localhost:5173`

## Run

1. Build and start:

```bash
npm run backend:up
```

2. Stop:

```bash
npm run backend:down
```

3. Logs:

```bash
npm run backend:logs
```

4. API contract tests:

```bash
npm --prefix backend test
```

## Docker Compose Fallback

If your machine has Docker Compose instead of Podman Compose:

```bash
npm run backend:up:docker
```

## Health Check

```bash
curl http://localhost:3001/health
```

Expected shape:

```json
{
  "ok": true,
  "redis": true,
  "lobbies": 0
}
```

## Minimal API Surface (Scaffold)

- `POST /api/v1/lobbies`
- `POST /api/v1/lobbies/:lobbyId/join`
- `PATCH /api/v1/lobbies/:lobbyId/settings`
- `POST /api/v1/lobbies/:lobbyId/start`
- `POST /api/v1/lobbies/:lobbyId/turns`
- `GET /ws` (websocket with `lobbyId` + `playerToken` query)

## Bruno Collection

- Collection path: `bruno/`
- Environment file: `bruno/environments/local.bru`
- Request flow (in order): `bruno/v1/00-health.bru` to `bruno/v1/07-submit-turn-stale.bru`

Notes:

- Run `01 Create Lobby` before requests that require `{{lobbyId}}` and `{{hostPlayerToken}}`.
- The collection stores `lobbyId`, `hostPlayerToken`, and `guestPlayerToken` from responses.

## Notes

- This is a scaffold for local development and protocol exploration.
- Current turn route enforces `revision` and `clientCommandId` dedupe, but does not yet run full game-rule validation.

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
4. In tab A:
   - Click `Host local lobby`.
   - Copy `Lobby ID`.
   - Click `Start race`.
5. In tab B:
   - Paste same `Lobby ID`.
   - Click `Join lobby`.
6. Drive turns locally; each human move/skip/pit action is submitted to backend and status updates are shown in `Backend: ...` text.
