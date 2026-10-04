# Backend Deploy on Render

Minimal setup for hosting the backend API on Render.

## Service Setup

- Create a new **Web Service** from this repo.
- Leave **Root Directory** empty (the repo root): the backend bundles the shared
  game engine from `src/game` and the track data from `public/tracks`.
- Runtime: `Node`.

## Build and Start

- **Build Command**

```bash
npm --prefix backend ci && npm --prefix backend run build
```

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
{ "ok": true, "lobbies": 0 }
```
