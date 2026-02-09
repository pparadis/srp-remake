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
