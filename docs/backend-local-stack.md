# Backend Local Stack

Containerized local multiplayer backend stack.

## Stack

- `Node.js 24` + `TypeScript`
- `Fastify` + `@fastify/websocket`
- In-memory lobby state and `clientCommandId` dedupe (lost on restart)
- `Podman + Podman Compose` orchestration (primary)

## Prerequisites

- Install container tooling (Ubuntu/WSL):

```bash
sudo apt update
sudo apt install -y podman podman-compose
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

1. Build and start:

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

- This is a scaffold for local development and protocol exploration.
- Current turn route enforces `revision` and `clientCommandId` dedupe, but does not yet run full game-rule validation.

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
4. In tab A:
   - Click `Host local lobby`.
   - Copy `Lobby ID`.
   - Click `Start race`.
5. In tab B:
   - Paste same `Lobby ID`.
   - Click `Join lobby`.
6. Drive turns locally; each human move/skip/pit action is submitted to backend and status updates are shown in `Backend: ...` text.

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
