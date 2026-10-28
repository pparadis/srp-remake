# AGENTS.md

Project guide for Codex and other automation.

## Repo Overview

- Game prototype in `src/` (Phaser).
- Race engine in `src/game/race/race_engine.ts` (no Phaser): validates and applies a turn, bots, pit penalties,
  laps and winner. Single-player (`RaceScene`) and the multiplayer server (`backend/`) both run it, so a rule
  change goes in `src/game/systems/*` or the engine, with tests, and applies to both.
- Race log in `src/game/race/race_log.ts` (#169): a race is `{ seats, raceLaps, seed, rulesVersion, actions }`, and
  `replayRace` rebuilds every state from it (the engine is deterministic). The solo session (`raceLog()`, null online
  and after a sandbox edit) and the server (`ServerRace.log`, never in the public lobby) log each action `applyAction`
  accepts. A new way to change a race must be a logged action, or the replay tests (`race_log.test.ts`, the session
  test, `backend/test/race_log.contract.test.ts`) fail. `replaySteps` gives each step's before, after and engine
  result; `raceRecap(ctx, log, nameOf)` (`src/game/systems/race_recap.ts`) turns that into the recap data: per car
  (place, grid setup, pit choices, moves with exact move points, passes) and per turn (the feed lines too, from
  `feedLines`). The recap page (`src/ui/recap_page.ts`, route `/recap/:id`, screen `recap`) shows the summary, a car's
  moves and pit choices and the turn by turn; names go in with `textContent`. A finished solo race is saved by
  `main.ts` (`saveRace` in `src/ui/recap_store.ts`: the last 10 in `localStorage["srp:races"]`, the scene sends the log
  in `srp:race-finished`), listed on the home screen and opened from the results screen; `recap_load.ts` builds the
  recap lazily so the engine is not in the first bundle. Online: `GET /lobbies/:id/recap` (bearer player token) gives `{ log,
names, trackId }` to a seated player once somebody has won (409 before, 401 bad token); the client asks for it as
  `srp:race-finished` arrives (`saveOnlineRace` in `main.ts`) and saves it like a solo race, so the Recap button shows
  once it is there. Reading a recap keeps the online session: Back returns to the lobby. The board replay (route
  `/recap/:id/board`, "Watch on the board" on the recap page) runs the race scene as a spectator of an online race:
  `replay_load.ts` dresses every replayed state as the server's lobby state (round-trips through `toEngineRace`), and
  `main.ts` sends them as `srp:backend-lobby-state` (`localPlayerId` empty: nobody is in control) from the replay bar
  (buttons, Left/Right, Play: `src/ui/replay_bar.ts`, #202; `main.ts` keeps `openReplay`, which opens the game; a public
  race becomes a `SavedRace` in `src/ui/remote_race.ts`). While a replay runs the live online events are not forwarded to the scene and the scene's
  `srp:race-finished` is ignored. Stepping back is a state change like any other: the cars glide back, the feed is the
  live feed's diff.
- Lazy chunks and deploys: the game, the recap and the replay are lazy chunks with hashed names, and a deploy removes the
  old ones, so a page loaded before it (an open tab, a home-screen app on an older copy) fails with "Importing a module
  script failed". Every lazy `import()` in `main.ts` goes through `importFresh` (`src/ui/lazy.ts`): it reloads the page
  once (the guard is a timestamp in `sessionStorage`), and if the chunk is still missing a moment later it says "A new
  version was deployed: reload the page." instead of looping. A new lazy import uses it too.
- Race session in `src/game/race/race_session.ts` (no Phaser): one page's view of the race. The solo turn loop (the
  player's action, then the bots), the online server state and its input hold, who controls the active car, the HUD
  snapshot, feel events, the finish and the sandbox edits. `RaceScene` owns one and only draws it (tokens, targets,
  tweens, pit modal, confetti, sounds); logic the scene needs goes in the session, with tests.
- Backend in `backend/` (Fastify + WebSocket): authoritative lobbies and races; bundles the shared engine.
  `backend/src/server.ts` is config, CORS, the error handler, rate limits and the routes. The realtime parts (#212) are
  `backend/src/realtime.ts`, one `createRealtime({ lobbyStore, raceStore, config, log })`: the socket registry and
  `broadcast`, the turn timer, the host grace, the bot-turn loop with `announceTurn`, the reaper and the heartbeat
  (`start()` / `stop()`; `createApp` calls `stop()` in `preClose`). A new timer or socket behaviour goes there, and its
  test is a direct one in `backend/test/realtime.test.ts` (a `LobbyStore`, fake sockets, `mock.timers`), not a contract test.
- Track data in `public/tracks/`; the tracks a race can be played on are listed in `src/game/track_ids.ts` (id and name,
  loaded by the page; `track_ids.test.ts` checks the list against the files and `backend/src/tracks.ts`). The Quick
  race card and the lobby card have a Track select (`lobbyTrack`): solo keeps it in `soloSettings.trackId`, online it
  is the lobby's `trackId`; `RaceComposition.trackId` goes to `startGame`, the registry (`REG_TRACK_ID`) and
  `BootScene`, which loads that JSON. Uploads, saved recaps and the replay use the race's own `trackId`.
- Track generator in `tools/`; track validation in `src/validation/`. `tools/gen_track.ts` (#175) builds a track from
  a closed centre line: a polygon of `corners` rounded by a radius is lane 1 (the right-hand lane, clockwise on screen
  or not), lanes 2 and 3 are exact offsets to its left and the pit lane an offset to its right (7 cells, the entry one
  cell before the line, boxes on its 3rd and 4th). Cells are `cellLength` apart on each stretch (a straight, a bend),
  the stretches being cut alike in every lane so the straights stay in line; an outer lane has more cells in a bend,
  like the oval. A track is a spec in `tools/track_specs.ts` and `npm run gen:tracks` writes its JSON (a test fails on a
  stale file); a lane that does not fit in a bend, a start line off the straight or corners too close for their radii
  throw. `validateTrack` also rejects two cells closer than 20. `oval16_3lanes.json` is older (its script is gone) and stays
  as it is, since the rule goldens and diagrams are made on it; `OVAL16` in the specs rebuilds it, and a test compares
  positions, zones, tags and the pit. `oval32_3lanes` is the same oval twice as big (56 cells a lap). A bigger track is
  a longer lap, not smaller cells: cars and cells keep their size, the camera fits the whole board, and the baked track
  texture is capped by `trackBakeScale` (`rendering/track_bake.ts`): the iOS canvas limit (`MAX_TRACK_TEXTURE_PIXELS`)
  and the WebGL renderer's own `getMaxTextureSize()` per side.
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

- Rules versions (#118): a race plays one movement-rules version (`RaceState.rulesVersion`, set by `createRace`, default
  `v3` since #148). The registry is `src/game/rules/versions.ts`: what differs between versions (target search, squeeze,
  draft test, and the tire, fuel and move-size rules via `rulesOf(state).resources` or `resourcesOf(state, trackIndex)`)
  goes through `rulesOf(state)`, never a direct import of `computeValidTargets` / `draftAhead` in engine code, nor of
  `cycleBudget` / `MOVE_RATES` / `MOVE_BUDGET` for a car. All three versions are **frozen**: `rules_golden.test.ts` replays `src/game/rules/golden/<version>.json` (made by
  `tools/rules_golden.ts`) and fails if a version's targets, prices or the car after the recorded move change, whether
  through its own code or shared code (constants, track, pit, wear). `v1` (before #114, tag `rules-v1`) has its own copy
  of the rule code in `src/game/rules/v1/` and is kept for reference, not online. `v2` (#114 and #102, tag `rules-v2`)
  has its own copy of the movement, draft and resource code in `src/game/rules/v2/`. `v3` (#148, tag `rules-v3`, the
  default) is the live code in `src/game/systems/` (`movement_system.ts`, `draft_system.ts`, `track_index.ts`,
  `resource_system.ts`): the movement rules below are v2's and v3's (v3 changes only the resources: three compounds, a
  fuel load, wear by move size, see `docs/movement-spec.md`). **To change the rules, make a v4**: copy v3's rule code to
  `src/game/rules/v3/` first (as v2's was), point v3 at the copy, then change the live code, add `v4` to
  `src/game/rules/ids.ts` and `versions.ts` (a `draft` while it is tried), and generate its golden file when you
  freeze it (`npx tsx tools/rules_golden.ts src/game/rules/golden/v4.json v4`; tag `rules-v4`). Compare versions on the
  same races: `npx tsx tools/rules_compare.ts [--rules v2,v3]` (the bots' ordering, overtakes, race length, how often
  tows, slingshots, squeezes and lane changes come up, lane use). A test that is written for one version's numbers
  passes it to `createRace` (`createRace(ctx, seats, laps, seed, 'v2')`) instead of relying on the default; the rule
  diagrams in `tools/diagrams/` play v2 (`positionOf`'s third argument) except `move-size`, which plays v3.
  `v4` (#138, a **draft**) is v3 plus a play order re-sorted by the standings every round (leader first,
  `leaderFirst` in `versions.ts`, `nextTurn` in `race_engine.ts`) and pit lane passing (#249, `pitLanePassing`: a car in
  the pit lane takes the first free cell ahead and may jump to a box past a taken one, so a jam cannot block the
  entry); it copies no rule code, and the server sends `turnOrder`. See `docs/movement-spec.md`.
  In solo the version is chosen in the Quick race card (`lobbyRules`, hidden online: online plays the default or the
  server's `RULES_VERSION`; `?rules=v1` only seeds that select, and the sandbox link carries it). The names live in `src/game/rules/ids.ts` (the
  page loads it eagerly), the rules in `versions.ts` (lazy, with the game). "Copy debug" records `rulesVersion`, and a
  sandbox "Load position" from other rules is refused.
- Movement is BFS on `next[]`. Movement rules compare cells by lap position (`lapAhead` in `track_index.ts`), never by
  `forwardIndex`, which repeats on the outer lanes' bends (#114). Laps use `forwardIndex`.
- No sideways lane changes: a lane-change target must be `DIAGONAL_MIN_GAIN` (0.5) ahead by lap position AND in a later
  zone than the start (except `PIT_ENTRY`); a route may still walk a sideways edge on the way (#108).
- Price = cells walked + diagonal lane changes (a change gaining 0.5 lap position or more; a sideways one is paid by
  its cell): one change +1, out and back +2. The search is by price (`searchRoutes` in `movement_system.ts`); see
  `docs/movement-spec.md`.
- A main-lane target is legal when a route over free cells reaches it within the move cap (#102); its price, cells and
  wear are that route's. No cap on how many cars a move passes: they are obstacles the route goes round, paid by its
  lane changes. The target lane is still at most one lane from the start lane. Squeeze applies only when nothing is
  reachable.
- Occupied cells are non-traversable for movement target search (except the start cell).
- Drafting (#55, #98): a move that ENDS 1-2 cells behind another car in the same lane (`draftAhead` in `draft_system.ts`,
  judged in `applyAction` after the move) puts the car in the tow: its next move wears less (fuel x0.8, tire x0.9), and
  after 2 such moves in a row (`Car.draftTurns`) a lane change skips the +1 surcharge (`TargetInfo.slingshot`). It is
  judged at the end of the move because every car has moved away by the start of the next turn (a start-of-turn rule
  never fired in a real race). Always on; see `docs/movement-spec.md`. The HUD (#83, #93): a draft chip in the phone
  bar, tows drawn on the board, a blue dashed ring on moves that keep the tow, gold on slingshot targets, toasts from
  `feel_events.ts` (`docs/strategy-and-feel.md`).
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
    (`crossesStartLine` in `move_commit_system.ts`; the cell is `Z01_L0_00`, under `Z01_L1_00`). The step from lane 1
    onto `PIT_ENTRY`, moves from `PIT_LINE` onward and the pit exit onto lane 1 never credit, so a stop credits one lap.
  - A pit-lane crossing can be the race-finishing one (first car to `raceLaps` wins, in order of crossing).
- Everyone covers the same distance from the start line. The front row starts on the line (`lapCount` 0, already in
  lap 1); cars in the rows behind the line (`forwardIndex` > 0) start at `-1`, and their first crossing (-1 to 0)
  only begins lap 1: silent (no toast, sound or feed line). `lapCountAtSpawn` in `src/game/systems/lap_progress.ts`
  sets it; the winner is the first car with `lapCount >= raceLaps`, so the rear row needs 1-3 cells more.
- Display uses the lap in progress (`lapInProgress`, `hasStartedLap`, `hasFinishedRace` in `lap_progress.ts`): "Lap 1 / 5"
  for pole, "Lap 0 / 5" plus a hint behind the line, "Finished" after the last crossing. Never show a negative lap.
- Standings rank by `lapCount`, then further along the lap by lap position (`rankPosition` in `track_index.ts`: unrounded,
  so two cells of one lane never tie, #114); the HUD gap is that difference in whole cells from the line, `+NL` only
  from a full lap. Pit cells have their own `forwardIndex` scale, so ranking and gaps use the lane-1 cell of the same
  zone: the pit entry counts as 27 (before the line), `PIT_LINE` as 0. The bots keep `progressOf` (`forwardIndex`).

## Race HUD

- The game renders with Phaser's WebGL only (`type: Phaser.WEBGL` in `src/game/index.ts`; why, and what it costs:
  `docs/adr/0001-webgl-only-renderer.md`; decisions of this size get an ADR in `docs/adr/`). The Canvas renderer
  and its `?renderer=canvas` switch were removed (#237): the last commit with them is the git tag `canvas-renderer`. It
  is a turn-based board, and software WebGL costs about 5x the CPU of Canvas (Phaser 4.2.1, `npm run probe:cpu`: 2.1 s
  against 10.3 s for an idle solo race plus a few turns), so a machine with no GPU acceleration is slow and has no
  fallback. The e2e suite and its pixel baselines run on WebGL (software GL on CI is deterministic);
  `e2e/smoke.spec.ts` asserts the canvas holds a WebGL context, and `e2e/webgl.spec.ts` plays a race to the end and
  starts another (leaving the race screen hides the container, 0x0, which a WebGL framebuffer cannot be:
  `keepGameSizeInSync` ignores a container with no size) and loses and restores the WebGL context mid-race (the board
  must look the same after; our baked textures come back by themselves). A browser with no WebGL gets a sentence on
  the home screen (`ui/webgl_support.ts`, asked once per page for the `webgl` context Phaser requests, and checked
  before the game chunk loads and before a lobby is hosted or joined), not a Phaser error. A real GPU is not measured yet (#232).
- Idle frame rate (#82): the game starts with an fps limit and `FrameGovernor` (`src/game/frame_governor.ts`, created by
  `RaceScene`) moves Phaser's `_limitRate` between full speed (1 ms, never 0: Phaser 4 keeps `delta % _limitRate`, and
  a 0 made it NaN and stopped the loop for good, #232) and 15 fps (`FRAME_RATES`). Full speed on any pointer, key,
  wheel or `srp:` event of the page (`watch`) and while `RaceScene.isAnimating()` says a glide, the camera tween, confetti
  or the pit modal moves, then 600 ms after. The halo pulse and a trail's fade do not count (they look stepped at the
  idle rate). A new animation that must be smooth goes through a tween, a timer-free thing the check can see; a new input
  source that changes the board without a pointer or `srp:` event needs its event in `WAKE_EVENTS`. The e2e (`test`) build
  keeps its fixed 10 fps cap (both rates 10), so `npm run probe:cpu` cannot show the adaptive rate: measure it with a
  temporary build override and the `P` readout (idle about 13 fps, a drag 60). Measured: 11.4 s of CPU for a 15 s idle race
  plus 3 turns uncapped, 3.8 s adaptive.
- Never draw a large texture every frame: the grass is the CSS background of `#app` behind a transparent canvas
  (`transparent: true`, `style.css`), not a Phaser `tileSprite`. A 4000x3000 `tileSprite` was redrawn each frame and
  Firefox on a real display (X11) fell to 9 fps while Chromium was at 60 (#79; headless Firefox did not show it, so
  check a real window with the `P` readout). Draw big static layers once (the track is baked with `generateTexture`).
- Sharpness on phones (on by default since #157, `?hidpi=0` turns it off): Phaser 3.90 has no `resolution` option, so
  the canvas would be 1x and a phone stretches it (blurry). `main.ts` reads the flag once and passes it to `startGame`:
  the game uses `Scale.NONE` with a canvas `renderScale()` times its container (`src/game/hidpi.ts`, capped at 3) shown
  at `zoom: 1 / renderScale()`; `keepGameSizeInSync` resizes it. Scene code works in canvas pixels: CSS sizes are
  multiplied by `renderScale()` and every `add.text` style takes `resolution: textResolution()` and
  `fontFamily: UI_FONT` (`src/game/ui_font.ts`, the system monospace: SF Mono on iOS, the generic `monospace` is
  Courier there; `style.css` uses the same stack); both scales are 1 at dpr 1 or with `?hidpi=0`. The first try (#58) left the race scene blank on an
  iPhone 17 (reverted in #59); it runs there since #88. A bare `?hidpi` also shows a probe line
  (`src/ui/diagnostics.ts`). Uncaught errors always show in the `crash-report` box (phones have no console).
- What repeats is baked once, never drawn or rasterised per frame (#88): the track at `renderScale()` pixels per unit
  (`drawTrack`: `generateTexture` replays `scaleCanvas`, shown at `1 / k`, so `?hidpi` is sharp), and the target rings,
  car bodies, number badges and confetti swatches as canvas textures (`rendering/baked_textures.ts`, at `renderScale()`
  times 2 so a 3x pinch stays sharp). Target rings and costs are pooled (`ui/target_markers.ts`); a new marker kind is a
  layer in `targetLayers`, not a Graphics call.
- The HUD (car card, turn banner, standings, hover tooltip, race feed, results table) is DOM, not canvas:
  `src/ui/hud.ts` renders the `srp:hud` snapshot that `RaceSession.hudSnapshot()` builds (`RaceScene.emitHud()`
  sends it). Add HUD data to the snapshot there; keep `hud.ts` free of Phaser. The grid setup menu is DOM too (`src/ui/setup_panel.ts`, #159: a modal over the HUD that
  scrolls on a short screen; its edits are `src/game/systems/setup_edit.ts`, shared with the pit modal). The pit modal
  (until its move, #159 step 2), Skip and Copy debug buttons stay in the canvas.
- Phones (issue #49): the page is sized with `100dvh` (`body` in `style.css`; `100vh` is only the fallback): on iOS
  Safari `100vh` is the screen without the browser bars, and `overflow: hidden` would cut off the bottom of the race
  screen while they show. Phaser can stay at the old size after a phone rotation (its `orientationchange` handler eats
  the size change), so `keepGameSizeInSync` (`src/game/game_size.ts`) re-applies the container's size to the game. The
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
- Car setup (#48, #148): `CarSetup.wing` is `low | medium | high` (`WING_EFFECTS` in `constants.ts`); on v3 also
  `compound` `hard | medium | soft` (`COMPOUND_TABLE`: cap, cycle budget, tire life) and `fuelLoad` (a multiple of 5, 40 to
  100; missing = 100). The cycle budget, cap and wear of a car are `resourcesOf(state, trackIndex)`'s (v3: the compound's
  budget plus the wing, minus 1 while the tank holds over `HEAVY_FUEL`; wear sized to the race length, by move points 7 /
  8 / 9, rounded to 0.1), never `MOVE_CYCLE.budget` for a car. The `setup` action (grid setup, before the first move, not
  a turn) sets it and `car.fuel = fuelLoad`; a stop refuels to `max(fuel, fuelLoad)`. Bots set up in `createRace` with
  `bestSetup`; the human's panel opens by itself on its first turn on v3. A change to the numbers must keep
  `npx tsx tools/bot_bench.ts --setups` (and `--rules v3`) passing the gate (`docs/bot-system.md`).
- Race feed (#92): `src/game/systems/race_feed.ts` (`feedLines(ctx, before, after, name)`, pure) turns the difference between
  two race states into `{ text, kind, carId }` lines (move, pass, lap, pit, warn, finish, info). Solo calls it after each
  action (`RaceSession.addFeed`, with a clone of the state before) and online after each server state, so both say the same.
  The engine has no log of its own; `HudSnapshot.log` carries `{ text, kind, mine }` and `hud.ts` styles by kind. The feed
  starts open except in the compact (phone) layout. A rule or resource that should be said goes in `feedLines`, with a case in
  `race_feed.test.ts`.
- Follow a car (#135): a click on its standings row (`srp:hud-command` `follow-car`) or a tap on its token
  (`RaceScene.tapBoard`: a target in reach wins, and the token the player may drag is never followed) calls
  `RaceSession.followCar` (again: stop; "All cars" too). The session keeps 500 feed lines and shows the last 30, only the
  followed car's (`carId`) while one is followed. It also keeps each car's last 24 moves (`CarMove`: cells, move points,
  tire/fuel used, pit, the `movePath`), recorded where `lastPaths` is (solo and online alike, from the state diff; online the
  move points come from the car's move cycle, `-` when it rolled over). `lastLapMoves` keeps those that ended within
  `spineLen` cells of the car; `HudSnapshot.follow` lists them and `RaceScene.drawFollowedCar()` draws them (a faint white
  line, dots, a ring round the car; `C` hides it). Page-only: an online reload starts it empty. Sandbox edits clear it.
- Strategy readouts (stint estimate, pit chip, result-aware tooltip, pit-modal stints) come from
  `src/game/systems/strategy.ts`, which reuses the bots' wear math in `bot_plan.ts`: do not write a second copy.
- Cars glide to their cells (#85): `RaceSession.drainMoves()` gives the cars that moved, in order, and
  `RaceScene.syncTokens()`/`glideTo` animate them along `movePath` (`src/game/systems/move_path.ts`, visual only: never
  feeds rules). Instant in the e2e build (`?anim` turns it on) and under `prefers-reduced-motion`; a spec that reads
  token positions right after a turn relies on that. A dragged car turns with the road under the finger (`easeAngle`,
  #110), a dropped drag glides from the drop point and a refused one glides back. Details: `docs/strategy-and-feel.md`.
  The glides of one round run one after another: each starts when the one before ends or is stopped (`glideTo`'s
  `afterCarId`, a paused tween resumed), not after a summed `delay`, which overlapped by about a frame (Phaser spends
  a tween's first frame starting it, #232).
  The race is ahead of the board (the bots play at once, the cars glide after), so nobody acts until the last glide has
  ended (#189): `syncTokens` sets `RaceSession.setCarsMoving(true)` when it starts glides, which makes
  `canControlActiveCar` / `localCanControl` / `canSkip` / `canSetup` false and hides the rings (`HudSnapshot.carsMoving`:
  "The other cars are moving"), and the scene's `UPDATE` hook calls `settleBoard()` once `glides` is empty (targets, halo,
  banner, the grid setup offer, the "your turn" chime). Input never waits on a flag the scene can lose: it is the glides.
- Camera (#87): the fit (`centerTrack`) plus the player's zoom 1 to 3 and pan (`rendering/camera_view.ts`, pure and
  tested); pinch, pan, wheel, double tap and the `Fit` button in `input/register_camera_gestures.ts`; the camera follows
  the player's car after its move while zoomed. The camera's matrix is refreshed at once (`cam.preRender()`) so a tap
  right after a pinch lands right. Details: `docs/strategy-and-feel.md`.
- Move preview and trail (#86): `RaceSession.previewFor()` (the path of the picked or hovered target) and
  `lastMovePath()` (each car's last move) feed `RaceScene.drawPreview()`/`showTrail()`; both reuse `movePath`.
- Feel: lap toast, finish confetti and sounds are driven by `src/game/systems/feel_events.ts` through
  `RaceSession.drainFeel()` (`RaceScene.reactToRace()` plays them); the first snapshot must never fire. Sound is `src/ui/sound.ts` (WebAudio, muted in
  test builds); `M` or the HUD button mutes, stored in `localStorage["srp:muted"]`. Details: `docs/strategy-and-feel.md`.

## Online Sessions

- Turn timer: lobby setting `turnTimerSec` (0|30|60|120, default 60). On expiry the server plays the stuck
  human's turn with the `"autopilot"` bot policy (`src/game/systems/bot_system.ts`, deliberately mediocre; it is also the weakest rung of the benchmark); the
  host can force it with `POST /lobbies/:id/force-skip`. A plain skip is illegal while moves exist.
- A new lobby setting must be threaded through every site: `backend/src/types.ts`, the zod patch schema AND
  `toSettingsPatch` in `server.ts`, `DEFAULT_SETTINGS` + `normalizeSettings` in `lobby_store.ts`, the client type
  in `src/net/backend_api.ts`, `index.html`, `src/main.ts`, and tests that assert on settings.
- Rename (#78): every player has a "Racing as" field in the lobby card (`lobby-name`); `PATCH /lobbies/:id/player`
  `{ name }` (same 1-32 name rule, 60 a minute, 401 bad token, 409 once the race has started: names are
  copied into the race) broadcasts `lobby.state`. The name goes to `srp:name` and the home field, so a reload rejoins
  with it. A guest with no saved name gets the field focused with a hint, after the join's busy state clears (a
  disabled field cannot take focus). Not `/join`: that is the reconnect path. A player with no saved name gets a
  Docker-style one (`src/ui/player_name.ts`, "steady_hairpin"), kept in `srp:name` and flagged `srp:name-auto` until
  they pick one, so the guest hint still shows for it.
- Race length (#211): one limit, `MAX_RACE_LAPS` (50) in `src/game/race/limits.ts`, for the lobby settings schema,
  `lobby_store.ts`, the Laps field and the upload's `raceLogSchema`. A log over `MAX_LOGGED_ACTIONS` (2000) is the byte
  bound of a history row: the page does not upload a solo race over it ("Too long to share") and `storeOnlineRace`
  skips it with a warning, since the row cap counts rows, not bytes.
- Race history (#170): `backend/src/race_store.ts`, a `RaceStore` (`insert`, `list`, `get`): `MemoryRaceStore` without
  `DATABASE_URL`, `PgRaceStore` (Neon) with it; both keep at most 500 races in memory, 2000 in Postgres (the table is public
  and anonymous, so one uploader must not fill the database). Over the limit the store drops the oldest race of the owner
  holding the most: an owner is a device, or a race with no device (an online one) on its own, and a tie goes to the owner
  whose oldest race is oldest. So a script that mints tokens takes races from its own tokens, not from real players'.
  Written as plain selects and a delete by id: pg-mem deletes every matching row for a delete over a `limit 1` subquery
  and crashes on `group by 1`, which real Postgres runs fine (#206 plans real-Postgres store tests). Anonymous: a race is its scrubbed log (`scrubLog` replaces the owner ids,
  no names). The server stores each finished online race after the broadcast (not awaited, a failure is logged) and
  `POST /api/v1/races` takes a solo race, replaying it with `replayRace` first. The id is a hash of the log, so a
  race is stored once. Device tokens (#194): `POST /api/v1/devices` (20 a day per IP) gives an anonymous token signed
  with `DEVICE_TOKEN_SECRET` (`backend/src/device_token.ts`, stateless, no account), `POST /api/v1/races` needs it as
  `Authorization: Bearer` (401 before any replay), and the store keeps `deviceHash(id)` in a `device` column, never
  given back, with at most `MAX_RACES_PER_DEVICE` (50) races per device (the next replaces its own oldest). The client
  keeps the token in `localStorage["srp:device"]` (`BackendApiClient.uploadRace` mints it, and on a 401 takes a new one
  and retries once). Tested with `pg-mem` standing in for Postgres (it differs from Postgres on `returning` after
  `on conflict do nothing`, so duplicates are found by a select first). On Neon: `DATABASE_URL` is the pooled URL (the
  app's queries), `DATABASE_URL_UNPOOLED` the direct one (only the `create table`); `neon.ts` / `.neon` / `.env.local`
  are the Neon CLI's (`.neon` and `.env.local` stay out of git); work against the `dev` branch, not `production`.
  The solo upload is on by default and can be turned off: the "Share my races anonymously" checkbox of the Quick race
  card (`srp:share-solo`: only an explicit `0` means off; solo only) makes `main.ts` send each finished solo race with
  `backendClient.uploadRace` after the results are up (`results-shared` says how it went; a failure never touches the
  local recap; a sandbox race has no log, so nothing goes). Online races need no setting: the server stores them. The public history is browsed at `/history` (home button "Public race history",
  `src/ui/history_page.ts`, `backendClient.listRaces`); `/history/:id` and `/history/:id/board` are the same recap and
  board replay as `/recap/:id`, with `remote: true` on the route: the race comes from `backendClient.readRace` instead
  of this browser's `localStorage`, is not saved there, and names its cars by seat (the log holds no names).
- Host reload keeps the lobby for `HOST_GRACE_SECONDS` (default 45). Sockets are tracked per player. Every socket is
  pinged every 30 s and one that has not answered the last ping is terminated, so a phone that dropped off the network
  becomes "disconnected" (and starts the host grace) instead of holding its lobby open for good.
- Test-only clocks: `TURN_TIMER_TIME_SCALE` (e.g. 0.1 makes "120 s" last 12 s) and `HOST_GRACE_SECONDS`;
  `playwright.config.ts` sets both for the backend it starts (e2e `createLobby` defaults the timer to Off).
  A reused local backend with real clocks breaks `e2e/afk.spec.ts`: use `E2E_BACKEND_PORT`.

- Chat (#70): `POST /lobbies/:id/chat` (1 message/s per player, last 50 kept per lobby, `chat.message` and
  `chat.history` on the socket, never inside `PublicLobby`). The text rule is `src/game/chat_text.ts` (100 graphemes,
  400 UTF-16 units), shared by the client and the server. The panel is `src/ui/chat.ts`: one element that `main.ts`
  moves between the lobby card and the race HUD; messages go in with `textContent` only. Keys typed in any form field
  are skipped by `onKeyDown` and the C/M handler (`isTypingTarget`). Solo has no chat.
- Player token in a header (#194 step 3): every lobby route reads it from `Authorization: Bearer` through
  `playerTokenOf` in `server.ts` (the header wins; none, or over 64 characters, is a 401), so a new lobby route calls
  that and never reads `playerToken` from its body or query. `BackendApiClient` sends it that way (`bearer()`), `start`,
  `reset` and `force-skip` take no body, and the WebSocket keeps `?playerToken=` (a browser sets no header on one). For
  one release the body and query fields still work, for a page loaded before the deploy: then delete the
  `optionalPlayerTokenSchema` fields, `playerTokenOf`'s second argument, the `legacy` half of
  `backend/test/player_token.contract.test.ts` and the old-form usages in the other contract tests. Who is asking is
  answered in one place (#213): `LobbyStore.requirePlayer(lobbyId, token, onInvalidToken?)` (lobby 404, token 401) and
  `requireHost(lobbyId, token, notHostMessage)` (then host 403). A new route or store method calls one of them and
  checks the lobby's state (409, #208) after, so a stranger learns nothing about the race; a route that logs a rejected
  token passes the logging as `onInvalidToken`. The websocket connect keeps its own check (it closes with a reason
  instead of throwing). `backend/test/lobby_store.test.ts` pins the order.
- Backend hardening (#69): request logs redact `playerToken` (`redactTokens`); lobbies with no open socket are reaped
  (`LOBBY_IDLE_SECONDS`, finished ones after 10 min); inputs are bounded (names 32, body 16 KiB, WS frames 1 KiB,
  `MAX_LOBBIES`); routes are rate limited per IP (`@fastify/rate-limit`, limits at the route in `server.ts`, keyed by
  `clientIpOf`). On Render the socket is always `127.0.0.1`, so the limits were one world-wide bucket until #210: set
  `CLIENT_IP_HEADER=cf-connecting-ip` there (the edge sets it and refuses a client-set one); never `TRUST_PROXY=true`,
  which takes the client's own `X-Forwarded-For` entry. Tests and e2e run with `RATE_LIMIT_ENABLED` off (a partial test config is off too); the
  limit and reaper tests are in `backend/test/hardening.contract.test.ts`. See `docs/backend-render-deploy.md`.

## Bots

- Levels (`Car.botLevel`, lobby/solo setting `botLevel`: easy | normal | hard, default normal) plus the server's
  AFK `"autopilot"`; `decideBotAction(ctx, state, policy?)` in `src/game/race/race_engine.ts` reads the active car's
  level when no policy is passed. Details, numbers and the personality table: `docs/bot-system.md`.
- The engine is deterministic: no `Math.random` in `src/game` or the backend (Easy's noise is seeded by car state).
- Every race has an integer `seed` (`RaceState.seed`), created only at the boundary (server at race start, `BOT_SEED`
  env pins it; solo in `src/main.ts`, `?seed=N` pins it; 0 = neutral). It decides each bot's personality
  (`personalityOf`), every car's grid slot (`gridSlots`) and the play order (`turnOrderOf`, pole sitter first).
  `src/game/systems/bot_style.ts` is the one place for these.
- Specs that assume car 1 on pole use seed 0 (`?seed=0` solo, `BOT_SEED=0` backend: set in `playwright.config.ts` and
  the `backend:test` script).
- Benchmark: `npx tsx tools/bot_bench.ts [--laps 5,8,12] [--lineup hard,normal,easy,autopilot]`; the ordering
  Hard < Normal < Easy < Autopilot (average finishing position) is asserted by `src/game/race/bot_levels.test.ts`, and
  `bot_personalities.test.ts` guards that no personality dominates. Run it after touching `bot_system.ts`, `bot_plan.ts`
  or `bot_hard.ts`.

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
  snapshot (same car count only). Phaser-free logic in `src/game/race/sandbox.ts`, panel in `src/ui/sandbox_panel.ts`,
  the e2e spec is `e2e/sandbox.spec.ts`. Plan and decisions: issue #38.
- The build version is shown bottom right on the home and lobby screens, not in a race (it sat over the board, on a phone over the bottom kerb), since a home-screen app can run an older copy than the browser (`src/ui/version.ts`): `web <sha> · <build day> ·
server <sha>`, amber when the server runs another commit (a deploy is pending); a click copies the full commits.
  The web side is `__GIT_SHA__` / `__BUILD_DATE__` (vite `define`), the server side is `/health`'s `sha`.
- Frame-rate readout (issue #79): press `P` during a race (or add `?fps` to the URL; a small `FPS` button shows on touch
  screens, in the right column or the phone drawer) for a line at the bottom left, out of the layout flow so it never
  moves the track it measures: `fps 58 · worst frame 34 ms`. `fps` is the frames the game rendered in the
  last second (Phaser's `postrender`, `src/ui/fps_meter.ts`, so a frame-rate cap shows up in it); `worst frame` is the
  longest gap between two renders in that second (a saturated main thread shows there first). Works in solo and online.
  Use it to compare before and after a rendering change, on the machine where it feels slow. No need to read it by
  hand on a desktop: `node tools/fps_probe.mjs [--browser chrome --browser firefox] [--runs 3]` (#232) plays a solo race
  in a headed browser (needs a display; Vite dev server, so the adaptive rate and `__srp` are there) and logs that line
  through idle, a car drag, wheel zoom, a pan and a turn with glides, with the GL renderer string so a software-GL run
  cannot pass for a GPU one. `PROBE_HEADED=1 PROBE_CHANNEL=chrome npm run probe:cpu` does the CPU probe on the real GPU.
- Snapshot includes `version` + `gitSha` and the race `seed` for reproducibility (`?seed=N`).

## Validation & Tests

- Track validation: `npm run validate:track` (runs `src/validation` tests; also runs before every build)
  - Checks spine lane existence, contiguous forwardIndex, and monotonic `next[]`.
- Tests: `npm test`
- CI: GitHub Actions runs validation, tests, and build (`.github/workflows/ci.yml`).

### Verification

- Why: each e2e page is headless Chromium (software WebGL is heavy: a full-suite run means many pages and used to push the
  machine to load 35-70), and timing-sensitive tests flake under load. A flake under load is never a reason to loosen a test.
- Locally run: `npm test`, `npm run test:coverage`, `npm run lint`, `npm run build`, `npm run backend:test`,
  `npm run backend:build`, plus ONLY the e2e specs the change touches, one chain at a time. Never the full e2e suite,
  the CI shards or repeat loops.
- Test layers, lowest first; put a check in the lowest one that can see the behavior:
  1. engine and systems (`src/game/race/race_engine.test.ts`, `src/game/systems/*.test.ts`): rules;
  2. race session (`src/game/race/race_session.test.ts`, `src/ui/hud_session.test.ts`): the turn loop, HUD data, feel
     events, online state and hold, played through a real race on the real track;
  3. page controller (`src/main.test.ts`, `src/main.multiplayer.test.ts`, the real `index.html` in jsdom with a
     `FakeWebSocket`): routing, lobby screens, mute, turn timer, host skip, disconnects;
  4. backend contract (`backend/test/*`, Fastify `inject`): the API, WebSocket sync, rules, AFK, bots. The race store
     tests (`race_store.test.ts`) also run on a real Postgres when `TEST_DATABASE_URL` is set (#206: `npm run db:up`;
     CI has a Postgres service), next to the pg-mem run; SQL changes get checked there, pg-mem is only the fast default;
  5. e2e (Playwright): whole journeys across pages or sockets, real pointer input, pixels and layout.
- A rule with an effect the player can see needs a reachability check, not only a test on a position you build:
  `src/game/race/feature_reach.test.ts` plays seeded bot-only races (nobody placing cars) and asserts how often each
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

1. Regenerate tracks: `npm run gen:tracks` (the specs in `tools/track_specs.ts`; `oval16_3lanes.json` is not rewritten); app icons from `public/icons/icon.svg`: `npm run gen:icons`
2. Validate track: `npm run validate:track`
3. Run tests: `npm test` (frontend), `npm run backend:test` (backend)
4. Multiplayer: run the backend next to the dev server (`npm --prefix backend run dev`); check it with
   `npm run backend:build` (typecheck + bundle).
5. E2E (Playwright, starts backend itself and builds `vite build --mode test` into `dist-e2e/`, served by `vite preview`; always a fresh build, never a reused server, so it cannot be stale): `npm run test:e2e`. Ports: `E2E_PORT` (5173), `E2E_BACKEND_PORT` (3001). `E2E_DEV=1` uses the Vite dev server instead (reused if already running locally). CI shards it: `npm run test:e2e -- --shard=1/2`.

## Troubleshooting

- If a test failure is reported, run `npm test` first to confirm the failure before using `npm run test:coverage`.
- From time to time, run `npm run build` to ensure the full build stays green.

## TypeScript style

- The reference is the [Google TypeScript style guide](https://google.github.io/styleguide/tsguide.html); a local clone
  is at `/home/pascal/code/styleguide/tsguide.html` (`git pull --ff-only` before reading). It is enforced by
  typescript-eslint with a curated rule set in `eslint.config.js` (not a preset): `npm run lint` must stay at 0 errors,
  and a new rule goes in only once its violations are 0. Enforced today: `interface` over object `type` aliases,
  no `any`, no `public`, no `#private`, no `const enum`, no default export, `Number()` instead of
  `parseInt` / `parseFloat`, `readonly` members that are never reassigned (type-aware), a `default` in every `switch`
  (an exhaustive one ends in `x satisfies never`), the guide's naming (`_name` stays for an unused parameter or an
  ignored destructured name; the bare `_` does not), and a top-level named function is a `function` declaration (a
  nested one may be an arrow, and so may an arrow with a type annotation).
- Tests (`*.test.ts`, `backend/test`, `e2e`) may use top-level arrow helpers.
- Deviation: `export default` in the config files (`vite`, `vitest`, `playwright`, and `neon.ts`), which the tools require.
- Type-aware rules run only on `src/**` and `backend/src/**` (the files a tsconfig covers); they add about 3 s to lint.
- Single quotes (#74) and the rest of the layout are Prettier's (`.prettierrc.json`): lint-staged runs it on every
  staged file and CI runs `npm run format:check`. The one-off reformat commit is in `.git-blame-ignore-revs`
  (`git config blame.ignoreRevsFile .git-blame-ignore-revs`).
- File names are snake_case (`race_engine.ts`, `race_scene.ts`, `race_engine.test.ts`), even a class's file (#75);
  `tools/file_names.test.ts` fails on a capital letter in a tracked `.ts` name. The `.mjs` scripts in `tools/` and the
  hyphenated e2e specs keep their names.
- No `!` and no object-literal `as` in `src/` and `backend/src/` (#77; tests, `tools/` and the frozen `src/game/rules/v1/`
  are exempt). A lookup that cannot miss goes through `must(value, 'what')` (`src/game/must.ts`), which throws a clear
  error: DOM parts, `map.get(id)` of an id just read, `array[i]` under `noUncheckedIndexedAccess`. Keep `what` a
  constant in a hot loop (the route search runs for every bot decision). A JSON import is typed by `parseTrack`
  (`src/validation/track_schema.ts`), a Phaser internal by a type guard (`isFrameLimit`, `pinToScreen`), not
  `as unknown as`.
- Not done yet, tracked separately: JSDoc on every top-level export (#76).

## Conventions

- Use `forwardIndex` for ordering/progress, not `zoneIndex`.
- Keep next[] connectivity and BFS unchanged unless explicitly required.
