# AGENTS.md

Project guide for Codex and other automation.

## Repo Overview

- Game prototype in `src/` (Phaser).
- Race engine in `src/game/race/raceEngine.ts` (no Phaser): validates and applies a turn, bots, pit penalties,
  laps and winner. Single-player (`RaceScene`) and the multiplayer server (`backend/`) both run it, so a rule
  change goes in `src/game/systems/*` or the engine, with tests, and applies to both.
- Backend in `backend/` (Fastify + WebSocket): authoritative lobbies and races; bundles the shared engine.
- Track data in `public/tracks/`.
- Track generator in `tools/`; track validation in `src/validation/`.
- Docs in `docs/`.

## Key Rules (Current)

- Movement is BFS on `next[]`. Forward progress ordering uses `forwardIndex`.
- No sideways lane changes: lane changes must advance `forwardIndex` (except `PIT_ENTRY`).
- Lane changes between main lanes cost +1 move spend.
- Passing/merging uses target-lane blockers:
  - Same-lane moves cannot pass the nearest car ahead.
  - Lane-change moves may pass one target-lane blocker to merge into a gap, but cannot pass the next blocker.
  - Adjacent lanes do not block unless they are the target lane.
- Occupied cells are non-traversable for movement target search (except the start cell).
- Pit lane rules:
  - Entry only via `PIT_ENTRY` from lane 1 (inner race lane).
  - Pit entry allowed only at distance 1 (no multi-zone jump).
  - Movement in pit lane is limited to 1 step, except if adjacent to a `PIT_BOX` you may target any `PIT_BOX` ahead.
  - Pit exit can connect to lane 1 (lane adjacency is not enforced for pit exit).

## Lap Counting

- Lap increments when `forwardIndex` wraps (from higher to lower) on non‑pit lanes.
- Decision made: no `START_FINISH` landing requirement; increment on wrap for non‑pit lanes.

## Race HUD

- The HUD (car card, turn banner, standings, hover tooltip, race feed, results table) is DOM, not canvas:
  `src/ui/hud.ts` renders the `srp:hud` snapshot that `RaceScene.emitHud()` sends. Add HUD data to the
  snapshot there; keep `hud.ts` free of Phaser. Pit modal, Skip and Copy debug buttons stay in the canvas.

## Debugging Tools

- In‑game debug:
  - Press `F` to toggle forwardIndex overlay (also shows full cell debug text in the HUD); `C` toggles cars+moves.
  - “Copy debug” button copies a JSON snapshot with car + movement context.
  - “Copy bot debug” button copies structured bot decision traces.
- Snapshot includes `version` + `gitSha` for reproducibility.

## Validation & Tests

- Track validation: `npm run validate:track` (runs `src/validation` tests; also runs before every build)
  - Checks spine lane existence, contiguous forwardIndex, and monotonic `next[]`.
- Tests: `npm test`
- CI: GitHub Actions runs validation, tests, and build (`.github/workflows/ci.yml`).

## Common Tasks

1. Regenerate track: `npm run gen:track`
2. Validate track: `npm run validate:track`
3. Run tests: `npm test` (frontend), `npm run backend:test` (backend)
4. Multiplayer: run the backend next to the dev server (`npm --prefix backend run dev`); check it with
   `npm run backend:build` (typecheck + bundle).
5. E2E (Playwright, starts backend + dev server itself): `npm run test:e2e`

## Troubleshooting

- If a test failure is reported, run `npm test` first to confirm the failure before using `npm run test:coverage`.
- From time to time, run `npm run build` to ensure the full build stays green.

## Conventions

- Use `forwardIndex` for ordering/progress, not `zoneIndex`.
- Keep next[] connectivity and BFS unchanged unless explicitly required.
