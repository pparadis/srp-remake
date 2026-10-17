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
- Rule diagrams in `docs/img/` are generated from the engine by `tools/diagrams/` (`npm run gen:diagrams`: SVG plus a
  PNG, and `diagrams.lock.json`, which ties each PNG to the SVG it was rendered from). A scenario (`scenario.ts`) is a
  race position built with the engine's own tools; the numbers come from `computeTargets` and `movePath`, and a wrong
  example throws. They are kept current three ways: the pre-commit hook regenerates them when engine code, the generator
  or a track is staged; `diagrams.test.ts` fails CI on a stale SVG, a PNG not rendered from its SVG, a file no diagram
  makes, or a diagram no `docs/*.md` embeds. So after a rule change look at the changed picture before you commit it.
  New significant rule: add its scenario to `allDiagrams` (`tools/diagrams/index.ts`) and embed `img/<name>.svg` next to
  its paragraph in the docs. Plan: issue #105.
- Plans are GitHub issues (label `plan`, plus `in-progress` once started; closed when shipped), not files in the repo.
  A PR for a plan says `Closes #N`; decisions and results go in issue comments.

## Workflow

- After pushing a branch, always open a PR; do not ask first.

## Key Rules (Current)

- Movement is BFS on `next[]`. Movement rules compare cells by lap position (`lapAhead` in `trackIndex.ts`), never by
  `forwardIndex`, which repeats on the outer lanes' bends (#114). Laps use `forwardIndex`.
- No sideways lane changes: a lane-change target must be `DIAGONAL_MIN_GAIN` (0.5) ahead by lap position AND in a later
  zone than the start (except `PIT_ENTRY`); a route may still walk a sideways edge on the way (#108).
- Price = cells walked + diagonal lane changes (a change gaining 0.5 lap position or more; a sideways one is paid by
  its cell): one change +1, out and back +2. The search is by price (`searchRoutes` in `movementSystem.ts`); see
  `docs/movement-spec.md`.
- Passing/merging uses target-lane blockers:
  - Same-lane moves cannot pass the nearest car ahead, except by going round it through ONE adjacent lane and rejoining
    (pass and return: at most one blocker passed, and at most one car in the lane it goes round through, as a merge).
  - Lane-change moves may pass one target-lane blocker to merge into a gap, but cannot pass the next blocker.
  - Adjacent lanes do not block unless they are the target lane.
- Occupied cells are non-traversable for movement target search (except the start cell).
- Drafting (#55, #98): a move that ENDS 1-2 cells behind another car in the same lane (`draftAhead` in `draftSystem.ts`,
  judged in `applyAction` after the move) puts the car in the tow: its next move wears less (fuel x0.8, tire x0.9), and
  after 2 such moves in a row (`Car.draftTurns`) a lane change skips the +1 surcharge (`TargetInfo.slingshot`). It is
  judged at the end of the move because every car has moved away by the start of the next turn (a start-of-turn rule
  never fired in a real race). Always on; see `docs/movement-spec.md`. The HUD (#83, #93): a draft chip in the phone
  bar, tows drawn on the board, a blue dashed ring on moves that keep the tow, gold on slingshot targets, toasts from
  `feelEvents.ts` (`docs/strategy-and-feel.md`).
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
- Never draw a large texture every frame: the grass is the CSS background of `#app` behind a transparent canvas
  (`transparent: true`, `style.css`), not a Phaser `tileSprite`. A 4000x3000 `tileSprite` was redrawn each frame and
  Firefox on a real display (X11) fell to 9 fps while Chromium was at 60 (#79; headless Firefox did not show it, so
  check a real window with the `P` readout). Draw big static layers once (the track is baked with `generateTexture`).
- Sharpness on phones (opt-in, `?hidpi`): Phaser 3.90 has no `resolution` option, so the canvas is 1x and a phone
  stretches it (blurry). With `?hidpi` (read once in `main.ts`, passed to `startGame`) the game uses `Scale.NONE` with a
  canvas `renderScale()` times its container (`src/game/hidpi.ts`, capped at 2) shown at `zoom: 1 / renderScale()`;
  `keepGameSizeInSync` resizes it. Scene code works in canvas pixels: CSS sizes are multiplied by `renderScale()` and every
  `add.text` style takes `resolution: textResolution()`; both are 1 without the flag. Turned on for everyone (#58), the
  race scene never started on an iPhone 17 (reverted in #59), so it stays opt-in until it works there; `?hidpi` also
  shows a probe line (`src/ui/diagnostics.ts`). Uncaught errors always show in the `crash-report` box (phones have no
  console).
- What repeats is baked once, never drawn or rasterised per frame (#88): the track at `renderScale()` pixels per unit
  (`drawTrack`: `generateTexture` replays `scaleCanvas`, shown at `1 / k`, so `?hidpi` is sharp), and the target rings,
  car bodies, number badges and confetti swatches as canvas textures (`rendering/bakedTextures.ts`, at `renderScale()`
  times 2 so a 3x pinch stays sharp). Target rings and costs are pooled (`ui/TargetMarkers.ts`); a new marker kind is a
  layer in `targetLayers`, not a Graphics call.
- The HUD (car card, turn banner, standings, hover tooltip, race feed, results table) is DOM, not canvas:
  `src/ui/hud.ts` renders the `srp:hud` snapshot that `RaceSession.hudSnapshot()` builds (`RaceScene.emitHud()`
  sends it). Add HUD data to the snapshot there; keep `hud.ts` free of Phaser. Pit modal, Skip and Copy debug buttons stay in the canvas.
- Phones (issue #49): the page is sized with `100dvh` (`body` in `style.css`; `100vh` is only the fallback): on iOS
  Safari `100vh` is the screen without the browser bars, and `overflow: hidden` would cut off the bottom of the race
  screen while they show. Phaser can stay at the old size after a phone rotation (its `orientationchange` handler eats
  the size change), so `keepGameSizeInSync` (`src/game/gameSize.ts`) re-applies the container's size to the game. The
  race screen is landscape-only (portrait shows `hud-rotate`). Under `(max-height: 500px)`
  (`COMPACT_HUD_QUERY` in `src/ui/layout.ts`, same query in `style.css`) the car card is a top bar, standings and the
  feed sit in a drawer (`hud-drawer-toggle`) and the canvas hides its debug buttons. Each HUD panel says where it takes
  room from the track with the `--hud-dock` CSS property; `RaceScene.centerTrack()` fits the track to what is left
  (`hudGutters`). Tap to move: a tap on the board (no drag) picks the nearest target in reach
  (`RaceSession.selectTarget`, cleared on every turn change); the HUD card's Move here / Cancel send
  `srp:hud-command`, and Move here goes through the same path as a drop (`resolvePlayerDragDrop`). Drag still works.
  Copying a cell id on press only happens with the F overlay on. `e2e/mobile.spec.ts` covers it. Add to Home Screen:
  `public/manifest.webmanifest` (fullscreen, landscape, relative URLs so the Pages base works) and the iOS tags in
  `index.html`; icons in `public/icons/` are rendered from `icon.svg` by `npm run gen:icons`. No service worker.
- Downforce (#48): `CarSetup.wing` is `low | medium | high` (`WING_EFFECTS`, `SOFT_PACE_BONUS` in `constants.ts`); the cycle
  budget is `cycleBudget(setup)` (40, +1 Low, -1 High, +1 soft), never `MOVE_CYCLE.budget` for a car. The `setup` action
  (grid setup, before the first move, not a turn) sets it; bots set up in `createRace` with `bestSetup`. A change to the
  numbers must keep `npx tsx tools/botBench.ts --setups` passing the gate (`docs/bot-system.md`).
- Strategy readouts (stint estimate, pit chip, result-aware tooltip, pit-modal stints) come from
  `src/game/systems/strategy.ts`, which reuses the bots' wear math in `botPlan.ts`: do not write a second copy.
- Cars glide to their cells (#85): `RaceSession.drainMoves()` gives the cars that moved, in order, and
  `RaceScene.syncTokens()`/`glideTo` animate them along `movePath` (`src/game/systems/movePath.ts`, visual only: never
  feeds rules). Instant in the e2e build (`?anim` turns it on) and under `prefers-reduced-motion`; a spec that reads
  token positions right after a turn relies on that. Details: `docs/strategy-and-feel.md`.
- Camera (#87): the fit (`centerTrack`) plus the player's zoom 1 to 3 and pan (`rendering/cameraView.ts`, pure and
  tested); pinch, pan, wheel, double tap and the `Fit` button in `input/registerCameraGestures.ts`; the camera follows
  the player's car after its move while zoomed. The camera's matrix is refreshed at once (`cam.preRender()`) so a tap
  right after a pinch lands right. Details: `docs/strategy-and-feel.md`.
- Move preview and trail (#86): `RaceSession.previewFor()` (the path of the picked or hovered target) and
  `lastMovePath()` (each car's last move) feed `RaceScene.drawPreview()`/`showTrail()`; both reuse `movePath`.
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

- Chat (#70): `POST /lobbies/:id/chat` (1 message/s per player, last 50 kept per lobby, `chat.message` and
  `chat.history` on the socket, never inside `PublicLobby`). The text rule is `src/game/chatText.ts` (100 graphemes,
  400 UTF-16 units), shared by the client and the server. The panel is `src/ui/chat.ts`: one element that `main.ts`
  moves between the lobby card and the race HUD; messages go in with `textContent` only. Keys typed in any form field
  are skipped by `onKeyDown` and the C/M handler (`isTypingTarget`). Solo has no chat.
- Backend hardening (#69): request logs redact `playerToken` (`redactTokens`); lobbies with no open socket are reaped
  (`LOBBY_IDLE_SECONDS`, finished ones after 10 min); inputs are bounded (names 32, body 16 KiB, WS frames 1 KiB,
  `MAX_LOBBIES`); routes are rate limited per IP (`@fastify/rate-limit`, limits at the route in `server.ts`). Behind a
  proxy set `TRUST_PROXY`. Tests and e2e run with `RATE_LIMIT_ENABLED` off (a partial test config is off too); the
  limit and reaper tests are in `backend/test/hardening.contract.test.ts`. See `docs/backend-render-deploy.md`.

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
- The build version is shown bottom right on the home and lobby screens, not in a race (it sat over the board, on a phone over the bottom kerb), since a home-screen app can run an older copy than the browser (`src/ui/version.ts`): `web <sha> · <build day> ·
server <sha>`, amber when the server runs another commit (a deploy is pending); a click copies the full commits.
  The web side is `__GIT_SHA__` / `__BUILD_DATE__` (vite `define`), the server side is `/health`'s `sha`.
- Frame-rate readout (issue #79): press `P` during a race (or add `?fps` to the URL; a small `FPS` button shows on touch
  screens, in the right column or the phone drawer) for a line at the bottom left, out of the layout flow so it never
  moves the track it measures: `fps 58 · worst frame 34 ms`. `fps` is the frames the game rendered in the
  last second (Phaser's `postrender`, `src/ui/fpsMeter.ts`, so a frame-rate cap shows up in it); `worst frame` is the
  longest gap between two renders in that second (a saturated main thread shows there first). Works in solo and online.
  Use it to compare before and after a rendering change, on the machine where it feels slow.
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
- A rule with an effect the player can see needs a reachability check, not only a test on a position you build:
  `src/game/race/featureReach.test.ts` plays seeded bot-only races (nobody placing cars) and asserts how often each
  rule comes up, in wide bands, and prints the numbers. A new such rule gets a line there. Drafting passed every
  constructed-position test while it fired on 0 of 498 real turns (#98).
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
