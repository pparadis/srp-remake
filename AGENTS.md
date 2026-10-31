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
  test, `backend/test/race_log.contract.test.ts`) fail.
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
- Track data in `public/tracks/`, generator in `tools/`, track validation in `src/validation/`.
- Docs in `docs/`: rules and design the code relies on (`movement-spec.md`, `bot-system.md`, ...).
- Rule diagrams in `docs/img/` are generated from the engine (`npm run gen:diagrams`): after a rule change look at the
  changed picture before you commit it.
- Plans are GitHub issues (label `plan`, plus `in-progress` once started; closed when shipped), not files in the repo.
  A PR for a plan says `Closes #N`; decisions and results go in issue comments.

## Guides

Reference for one area of the code is kept in a skill, so it is only loaded when needed. Claude Code picks one by its
description; any other tool should read the file before working in that area.

- Race screen, HUD, renderer, phones, camera (`src/game/scenes/`, `src/ui/hud.ts`, `style.css`):
  `.claude/skills/race-hud/SKILL.md`
- Online play, lobby settings, backend, race history (`backend/`, `src/net/`, lobby screens):
  `.claude/skills/online-sessions/SKILL.md`
- Recap page, saved races, board replay: `.claude/skills/race-recap/SKILL.md`
- Adding or changing a track, the rule diagrams: `.claude/skills/tracks-and-diagrams/SKILL.md`
- Debug overlays, sandbox, frame-rate readout and probes: `.claude/skills/debug-tools/SKILL.md`

## Workflow

- After pushing a branch, always open a PR; do not ask first.
- After opening a PR or pushing to one, watch its checks in the background (`gh pr checks <n> --watch`; right after a
  push it can say "no checks reported", so retry after a few seconds) and fix what fails on the same branch until they
  are green, then say so. Stop and report after 3 fix attempts, or when the failure is not this PR's (a flake, an
  infrastructure problem). Never merge, bypass a check, loosen a test or regenerate a pixel baseline to get there.

## Key Rules (Current)

- Rules versions (#118): a race plays one movement-rules version (`RaceState.rulesVersion`, set by `createRace`, default
  `v4`; it was v3 from #148). The registry is `src/game/rules/versions.ts`: what differs between versions (target search, squeeze,
  draft test, and the tire, fuel and move-size rules via `rulesOf(state).resources` or `resourcesOf(state, trackIndex)`)
  goes through `rulesOf(state)`, never a direct import of `computeValidTargets` / `draftAhead` in engine code, nor of
  `cycleBudget` / `MOVE_RATES` / `MOVE_BUDGET` for a car. All four versions are **frozen**: `rules_golden.test.ts` replays `src/game/rules/golden/<version>.json` (made by
  `tools/rules_golden.ts`) and fails if a version's targets, prices or the car after the recorded move change, whether
  through its own code or shared code (constants, track, pit, wear). `v1` and `v2` were retired (#254): not selectable, no code; the git tags `rules-v1`, `rules-v2` and `retired-v1-v2` hold their code, golden files, docs and diagrams. A race of theirs already in the history (or saved in a browser) keeps its stats and cannot be replayed (`replayBlock` in `ids.ts`: the recap and board replay say why, the history row is not clickable). `v3` (#148, tag `rules-v3`) and `v4`
  (the default) share the live code in `src/game/systems/` (`movement_system.ts`, `draft_system.ts`, `track_index.ts`,
  `resource_system.ts`): the movement rules below are those of v3 and v4 (v3 changed the resources of the older rules: three compounds, a
  fuel load, wear by move size, see `docs/movement-spec.md`). **To change the rules, make a v5**: copy the live rule code to
  `src/game/rules/v4/` first (as v2's was; v3 and v4 both point at it), then change the live code, add `v5` to
  `src/game/rules/ids.ts` and `versions.ts` (a `draft` while it is tried), and generate its golden file when you
  freeze it (`npx tsx tools/rules_golden.ts src/game/rules/golden/v5.json v5`; tag `rules-v5`). Compare versions on the
  same races: `npx tsx tools/rules_compare.ts [--rules v3,v4]` (the bots' ordering, overtakes, race length, how often
  tows, slingshots, squeezes and lane changes come up, lane use). A test that is written for one version's numbers
  passes it to `createRace` (`createRace(ctx, seats, laps, seed, 'v3')`) instead of relying on the default; the rule
  diagrams in `tools/diagrams/` play v3 with car 1 on soft tires (cap 9), set in `positionOf`; the e2e specs play v3 too (`?rules=v3`,
  backend `RULES_VERSION=v3`), and `dismissGridSetup` in `e2e/support/game.ts` closes the grid setup panel that v3 and v4 open.
  `v4` (#138, #249, frozen with a golden file; tag `rules-v4`) is v3 plus a play order re-sorted by the standings every round (leader first,
  `leaderFirst` in `versions.ts`, `nextTurn` in `race_engine.ts`) and pit lane passing (#249, `pitLanePassing`: a car in
  the pit lane takes the first free cell ahead and may jump to a box past a taken one, so a jam cannot block the
  entry); it copies no rule code, and the server sends `turnOrder`. See `docs/movement-spec.md`.
  In solo the version is chosen in the Quick race card (`lobbyRules`, hidden online: online plays the default or the
  server's `RULES_VERSION`; `?rules=v3` only seeds that select (an unknown or retired value is the default), and the sandbox link carries it). The names live in `src/game/rules/ids.ts` (the
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
  the CI shards or repeat loops (`.claude/hooks/e2e_guard.py` refuses them).
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
