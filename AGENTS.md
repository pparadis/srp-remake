# AGENTS.md

Project guide for Codex and other automation.

## Repo Overview

- Game prototype in `src/` (Phaser).
- Race engine in `src/game/race/raceEngine.ts` (no Phaser): validates and applies a turn, bots, pit penalties,
  laps and winner. Single-player (`RaceScene`) and the multiplayer server (`backend/`) both run it, so a rule
  change goes in `src/game/systems/*` or the engine, with tests, and applies to both.
- Race session in `src/game/race/raceSession.ts` (no Phaser): one page's view of the race. The solo turn loop (the
  player's action, then the bots), the online server state and its input hold, who controls the active car, the HUD
  snapshot, feel events, the finish and the sandbox edits. `RaceScene` owns one and only draws it (tokens, targets,
  tweens, pit modal, confetti, sounds); logic the scene needs goes in the session, with tests.
- Backend in `backend/` (Fastify + WebSocket): authoritative lobbies and races; bundles the shared engine.
- Track data in `public/tracks/`.
- Track generator in `tools/`; track validation in `src/validation/`.
- Docs in `docs/`: rules and design the code relies on (`movement-spec.md`, `bot-system.md`, ...).
- Plans are GitHub issues (label `plan`, plus `in-progress` once started; closed when shipped), not files in the repo.
  A PR for a plan says `Closes #N`; decisions and results go in issue comments.

## Key Rules (Current)

- Movement is BFS on `next[]`. Forward progress ordering uses `forwardIndex`.
- No sideways lane changes: lane changes must advance `forwardIndex` (except `PIT_ENTRY`).
- Every lane change between main lanes costs +1 move spend; further diagonal changes in one route add +1 each (out and
  back +2). The search is by price (`searchRoutes` in `movementSystem.ts`); see `docs/movement-spec.md`.
- Passing/merging uses target-lane blockers:
  - Same-lane moves cannot pass the nearest car ahead, except by going round it through ONE adjacent lane and rejoining
    (pass and return: at most one blocker passed, and at most one car in the lane it goes round through, as a merge).
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

- The game uses Phaser's Canvas renderer on purpose (`type: Phaser.CANVAS` in `src/game/index.ts`): it is a turn-based
  board, and software WebGL cost about 14x the CPU (`npm run probe:cpu`). Do not add WebGL-only features (tint, FX,
  pipelines, shaders, masks, blend modes, particles). `e2e/smoke.spec.ts` asserts the canvas has a 2D context.
- The HUD (car card, turn banner, standings, hover tooltip, race feed, results table) is DOM, not canvas:
  `src/ui/hud.ts` renders the `srp:hud` snapshot that `RaceSession.hudSnapshot()` builds (`RaceScene.emitHud()`
  sends it). Add HUD data to the snapshot there; keep `hud.ts` free of Phaser. Pit modal, Skip and Copy debug buttons stay in the canvas.
- Phones (issue #49): the race screen is landscape-only (portrait shows `hud-rotate`). Under `(max-height: 500px)`
  (`COMPACT_HUD_QUERY` in `src/ui/layout.ts`, same query in `style.css`) the car card is a top bar, standings and the
  feed sit in a drawer (`hud-drawer-toggle`) and the canvas hides its debug buttons. Each HUD panel says where it takes
  room from the track with the `--hud-dock` CSS property; `RaceScene.centerTrack()` fits the track to what is left
  (`hudGutters`). Tap to move: a tap on the board (no drag) picks the nearest target in reach
  (`RaceSession.selectTarget`, cleared on every turn change); the HUD card's Move here / Cancel send
  `srp:hud-command`, and Move here goes through the same path as a drop (`resolvePlayerDragDrop`). Drag still works.
  Copying a cell id on press only happens with the F overlay on. `e2e/mobile.spec.ts` covers it. Add to Home Screen:
  `public/manifest.webmanifest` (fullscreen, landscape, relative URLs so the Pages base works) and the iOS tags in
  `index.html`; icons in `public/icons/` are rendered from `icon.svg` by `npm run gen:icons`. No service worker.
- Strategy readouts (stint estimate, pit chip, result-aware tooltip, pit-modal stints) come from
  `src/game/systems/strategy.ts`, which reuses the bots' wear math in `botPlan.ts`: do not write a second copy.
- Feel: lap toast, finish confetti and sounds are driven by `src/game/systems/feelEvents.ts` through
  `RaceSession.drainFeel()` (`RaceScene.reactToRace()` plays them); the first snapshot must never fire. Sound is `src/ui/sound.ts` (WebAudio, muted in
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

## Bots

- `decideBotAction(ctx, state, policy?)` in `src/game/race/raceEngine.ts`; levels easy / normal / hard and the AFK
  `autopilot` (unchanged). Details, numbers and the personality table: `docs/bot-system.md`.
- Every race has an integer `seed` (`RaceState.seed`), created only at the boundary (server at race start, `BOT_SEED`
  env pins it; solo in `src/main.ts`, `?seed=N` pins it; 0 = neutral). It decides each bot's personality
  (`personalityOf`), every car's grid slot (`gridSlots`) and the play order (`turnOrderOf`, pole sitter first).
  `src/game/systems/botStyle.ts` is the one place for these; no `Math.random` in `src/game` or the backend race code.
- Specs that assume car 1 on pole use seed 0 (`?seed=0` solo, `BOT_SEED=0` backend: set in `playwright.config.ts` and
  the `backend:test` script).
- Benchmark: `npx tsx tools/botBench.ts` (see the doc); `botPersonalities.test.ts` guards that no personality dominates.

## Debugging Tools

- In‑game debug:
  - Press `F` to toggle forwardIndex overlay (also shows full cell debug text in the HUD); `C` toggles cars+moves.
  - “Copy debug” button copies a JSON snapshot with car + movement context.
  - “Copy bot debug” button copies structured bot decision traces.
- Sandbox (solo dev tool): open the app with `?sandbox` (add `&seed=N`; `&pos=<base64>` starts from a position), then Quick race.
  `E` toggles edit mode (bots wait): drag any car to any free cell, press a car to make it the one to play, edit its
  cell, lap, tire, fuel, compound, driver and move points in the panel; targets recompute live. `E` again plays on with
  the normal rules. "Copy as test" copies the position as a vitest case (offered targets as the expectation: edit the
  wrong entry and it is the failing test), "Copy link" a `?sandbox&pos=` URL, "Load position" takes a "Copy debug"
  snapshot (same car count only). Phaser-free logic in `src/game/race/sandbox.ts`, panel in `src/ui/sandboxPanel.ts`,
  the e2e spec is `e2e/sandbox.spec.ts`. Plan and decisions: issue #38.
- The build version is shown bottom right on the home and lobby screens (`src/ui/version.ts`): `web <sha> · <build day> ·
server <sha>`, amber when the server runs another commit (a deploy is pending); a click copies the full commits.
  The web side is `__GIT_SHA__` / `__BUILD_DATE__` (vite `define`), the server side is `/health`'s `sha`.
- Snapshot includes `version` + `gitSha` and the race `seed` for reproducibility (`?seed=N`).

## Validation & Tests

- Track validation: `npm run validate:track` (runs `src/validation` tests; also runs before every build)
  - Checks spine lane existence, contiguous forwardIndex, and monotonic `next[]`.
- Tests: `npm test`
- CI: GitHub Actions runs validation, tests, and build (`.github/workflows/ci.yml`).

### Verification

- Why: each e2e page is headless Chromium (the game now uses the light Canvas renderer, but a full-suite run still means
  many pages; it used to push the machine to load 35-70 with software WebGL), and timing-sensitive tests flake under load. A flake under load is never a reason to loosen a test.
- Locally run: `npm test`, `npm run test:coverage`, `npm run lint`, `npm run build`, `npm run backend:test`,
  `npm run backend:build`, plus ONLY the e2e specs the change touches, one chain at a time. Never the full e2e suite,
  the CI shards or repeat loops.
- Test layers, lowest first; put a check in the lowest one that can see the behavior:
  1. engine and systems (`src/game/race/raceEngine.test.ts`, `src/game/systems/*.test.ts`): rules;
  2. race session (`src/game/race/raceSession.test.ts`, `src/ui/hudSession.test.ts`): the turn loop, HUD data, feel
     events, online state and hold, played through a real race on the real track;
  3. page controller (`src/main.test.ts`, `src/main.multiplayer.test.ts`, the real `index.html` in jsdom with a
     `FakeWebSocket`): routing, lobby screens, mute, turn timer, host skip, disconnects;
  4. backend contract (`backend/test/*`, Fastify `inject`): the API, WebSocket sync, rules, AFK, bots;
  5. e2e (Playwright): whole journeys across pages or sockets, real pointer input, pixels and layout.
- A new e2e test must justify that it needs a real browser (a journey across pages or sockets, real pointer input, or
  pixels); everything else goes in a unit, session, page-controller or contract test.
- One spec: `GITHUB_ACTIONS=true GITHUB_REPOSITORY=pparadis/srp-remake E2E_PORT=5399 E2E_BACKEND_PORT=3311 npx playwright test e2e/track.spec.ts --workers=2`
- The 2 screenshot tests (`track` `race-start.png`, `hud` `race-hud.png`) run only when `CI` is set: their baselines
  match the Chromium build CI installs for the locked Playwright, so they are the final pixel check on the PR.
- CI runs the full suite and the 2 shards (about 2.5 min). Watch it with `gh run watch` (or `gh run watch <id>`).
- The e2e (`--mode test`) build caps the game at 10 fps (`src/game/index.ts`); `npm run probe:cpu` measures the browser CPU
  seconds of a variant (see `tools/cpuProbe.mjs`).

## Common Tasks

1. Regenerate track: `npm run gen:track`; app icons from `public/icons/icon.svg`: `npm run gen:icons`
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
