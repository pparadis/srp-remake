# Backend Local Stack

Containerized local multiplayer backend stack.

## Stack

- `Node.js 20` + `TypeScript`
- `Fastify` + `@fastify/websocket`
- `Redis` for dedupe cache (`clientCommandId`)
- `Docker Compose` orchestration

## Services

- `api` (`localhost:3001`)
- `redis` (`localhost:6379`)

## Run

1. Build and start:

```bash
docker compose up --build
```

2. Stop:

```bash
docker compose down
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

- `POST /api/lobby.create`
- `POST /api/lobby.join`
- `POST /api/lobby.updateSettings`
- `POST /api/lobby.startRace`
- `POST /api/turn.submit`
- `GET /ws` (websocket with `lobbyId` + `playerToken` query)

## Notes

- This is a scaffold for local development and protocol exploration.
- Current turn route enforces `revision` and `clientCommandId` dedupe, but does not yet run full game-rule validation.
