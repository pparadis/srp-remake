# Backend Deploy on Render

Minimal setup for hosting the backend API on Render.

## Service Setup

- Create a new **Web Service** from this repo.
- Set **Root Directory** to `backend`.
- Runtime: `Node`.

## Build and Start

- **Build Command**

```bash
npm ci && npm run build
```

- **Start Command**

```bash
npm run start
```

## Required Environment Variables

- `HOST=0.0.0.0`
- `REDIS_URL=<your render redis url>`
- `DEDUPE_TTL_SECONDS=3600`
- `CORS_ALLOWED_ORIGINS=<frontend origin(s)>`
- `PLAYER_TOKEN_TTL_SECONDS=86400`
- `ADMIN_DEBUG_ENABLED=false`
- `ADMIN_DEBUG_TOKEN=<set only if ADMIN_DEBUG_ENABLED=true>`

Example `CORS_ALLOWED_ORIGINS`:

```text
https://your-frontend.example.com,http://localhost:5173
```

## Health Check

- Set health check path to:

```text
/health
```

## Quick Verify

After deploy:

```bash
curl https://<your-render-service>/health
```

Expected:

```json
{ "ok": true, "redis": true, "lobbies": 0 }
```
