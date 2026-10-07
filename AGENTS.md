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
- Squeeze: only when a car has no normal target, `computeTargets` offers targets that pass cars (free target cell, main lanes, +2 move points per car passed); also from the `PIT_EXIT` cell onto lane 1 (max 3 cells); see `docs/movement-spec.md`.
- Pit lane rules:
  - Entry only via `PIT_ENTRY` from lane 1 (inner race lane).
  - Pit entry allowed only at distance 1 (no multi-zone jump).
  - Movement in pit lane is limited to 1 step, except if adjacent to a `PIT_BOX` you may target any `PIT_BOX` ahead.
  - Pit exit can connect to lane 1 (lane adjacency is not enforced for pit exit).

## Lap Counting

- `Car.lapCount` is the number of COMPLETED laps. It increments by exactly one when the car crosses the start line,
  in ANY lane (the line spans the pit lane too, as in F1). No `START_FINISH` landing requirement.
  - Main lanes: `forwardIndex` wraps (from higher to lower) between two non-pit cells.
  - Pit lane: a move along the pit lane that starts before the `PIT_LINE` cell and lands on or beyond it
    (`crossesStartLine` in `moveCommitSystem.ts`; the cell is `Z01_L0_00`, under `Z01_L1_00`). The step from lane 1
    onto `PIT_ENTRY`, moves from `PIT_LINE` onward and the pit exit onto lane 1 never credit, so a stop credits one lap.
  - A pit-lane crossing can be the race-finishing one (first car to `raceLaps` wins, in order of crossing).
- Everyone covers the same distance from the start line. The front row starts on the line (`lapCount` 0, already in
  lap 1); cars in the rows behind the line (`forwardIndex` > 0) start at `-1`, and their first crossing (-1 to 0)
  only begins lap 1: silent (no toast, sound or feed line). `lapCountAtSpawn` in `src/game/systems/lapProgress.ts`
  sets it; the winner is the first car with `lapCount >= raceLaps`, so the rear row needs 1-3 cells more.
- Display uses the lap in progress (`lapInProgress`, `hasStartedLap`, `hasFinishedRace` in `lapProgress.ts`): "Lap 1 / 5"
  for pole, "Lap 0 / 5" plus a hint behind the line, "Finished" after the last crossing. Never show a negative lap.
- Standings rank by `lapCount`, then further along the lap (higher `forwardIndex`); the HUD gap is in cells from the line,
  `+NL` only from a full lap. Pit cells have their own `forwardIndex` scale, so ranking and gaps use the lane-1 cell of
  the same zone (`trackFwd` in `trackIndex.ts`): the pit entry counts as 27 (before the line), `PIT_LINE` as 0.

## Race HUD

- The HUD (car card, turn banner, standings, hover tooltip, race feed, results table) is DOM, not canvas:
  `src/ui/hud.ts` renders the `srp:hud` snapshot that `RaceScene.emitHud()` sends. Add HUD data to the
  snapshot there; keep `hud.ts` free of Phaser. Pit modal, Skip and Copy debug buttons stay in the canvas.
- Strategy readouts (stint estimate, pit chip, result-aware tooltip, pit-modal stints) come from
  `src/game/systems/strategy.ts`, which reuses the bots' wear math in `botPlan.ts`: do not write a second copy.
- Feel: lap toast, finish confetti and sounds are driven by `src/game/systems/feelEvents.ts` from
  `RaceScene.reactToRace()`; the first snapshot must never fire. Sound is `src/ui/sound.ts` (WebAudio, muted in
  test builds); `M` or the HUD button mutes, stored in `localStorage["srp:muted"]`. Details: `docs/strategy-and-feel.md`.

## Online Sessions

- Turn timer: lobby setting `turnTimerSec` (0|30|60|120, default 60). On expiry the server plays the stuck
  human's turn with the `"autopilot"` bot policy (`src/game/systems/botSystem.ts`, deliberately mediocre; it is also the weakest rung of the benchmark); the
  host can force it with `POST /lobbies/:id/force-skip`. A plain skip is illegal while moves exist.
- A new lobby setting must be threaded through every site: `backend/src/types.ts`, the zod patch schema AND
  `toSettingsPatch` in `server.ts`, `DEFAULT_SETTINGS` + `normalizeSettings` in `lobbyStore.ts`, the client type
  in `src/net/backendApi.ts`, `index.html`, `src/main.ts`, and tests that assert on settings.
- Host reload keeps the lobby for `HOST_GRACE_SECONDS` (default 45). Sockets are tracked per player.
- Test-only clocks: `TURN_TIMER_TIME_SCALE` (e.g. 0.1 makes "120 s" last 12 s) and `HOST_GRACE_SECONDS`;
  `playwright.config.ts` sets both for the backend it starts (e2e `createLobby` defaults the timer to Off).
  A reused local backend with real clocks breaks `e2e/afk.spec.ts`: use `E2E_BACKEND_PORT`.

## Bots

- Levels (`Car.botLevel`, lobby/solo setting `botLevel`: easy | normal | hard, default normal) plus the server's
  AFK `"autopilot"`; `decideBotAction(ctx, state, policy?)` reads the active car's level when no policy is passed.
  Details and benchmark numbers: `docs/bot-system.md`.
- The engine is deterministic: no `Math.random` in `src/game` or the backend (Easy's noise is seeded by car state).
- Benchmark: `npx tsx tools/botBench.ts [--laps 5,8,12] [--lineup hard,normal,easy,autopilot]`; the ordering
  Hard < Normal < Easy < Autopilot (average finishing position) is asserted by `src/game/race/botLevels.test.ts`.
  Run it after touching `botSystem.ts`, `botPlan.ts` or `botHard.ts`.

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

### Verification

- Why: each e2e page is headless Chromium with software WebGL; the full suite pushes the machine to load 35-70, and
  timing-sensitive tests then flake. A flake under load is never a reason to loosen a test.
- Locally run: `npm test`, `npm run test:coverage`, `npm run lint`, `npm run build`, `npm run backend:test`,
  `npm run backend:build`, plus ONLY the e2e specs the change touches, one chain at a time. Never the full e2e suite,
  the CI shards or repeat loops.
- One spec: `GITHUB_ACTIONS=true GITHUB_REPOSITORY=pparadis/srp-remake E2E_PORT=5399 E2E_BACKEND_PORT=3311 npx playwright test e2e/hud.spec.ts --workers=2`
- CI runs the full suite and the 2 shards (about 2.5 min). Watch it with `gh run watch` (or `gh run watch <id>`).
- The e2e (`--mode test`) build caps the game at 10 fps (`src/game/index.ts`); `npm run probe:cpu` measures the browser CPU
  seconds of a variant (see `tools/cpuProbe.mjs`).

## Common Tasks

1. Regenerate track: `npm run gen:track`
2. Validate track: `npm run validate:track`
3. Run tests: `npm test` (frontend), `npm run backend:test` (backend)
4. Multiplayer: run the backend next to the dev server (`npm --prefix backend run dev`); check it with
   `npm run backend:build` (typecheck + bundle).
5. E2E (Playwright, starts backend itself and builds `vite build --mode test` into `dist-e2e/`, served by `vite preview`; always a fresh build, never a reused server, so it cannot be stale): `npm run test:e2e`. Ports: `E2E_PORT` (5173), `E2E_BACKEND_PORT` (3001). `E2E_DEV=1` uses the Vite dev server instead (reused if already running locally). CI shards it: `npm run test:e2e -- --shard=1/2`.

## Troubleshooting

- If a test failure is reported, run `npm test` first to confirm the failure before using `npm run test:coverage`.
- From time to time, run `npm run build` to ensure the full build stays green.

## Conventions

- Use `forwardIndex` for ordering/progress, not `zoneIndex`.
- Keep next[] connectivity and BFS unchanged unless explicitly required.
