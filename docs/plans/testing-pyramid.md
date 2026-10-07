# Testing pyramid: move behavior checks down, keep e2e for journeys and visuals

Status: Planned

## Context

The goal is to rely less on e2e and put the investment at the base of the pyramid. e2e should cover whole-game
journeys and visual accuracy.

Where the suite stands (on `origin/main` @ 3fcc0b5):

- **Unit tests (vitest, jsdom):** about 35 files. The engine and systems are well covered (`raceEngine`, `movement`,
  `ordering`, `bots`, `pit`, `lap`). Coverage thresholds are 92/80/92/95.
- **Page-controller tests:** `src/main.test.ts` and `src/main.multiplayer.test.ts` load the real `index.html` into
  jsdom and use a `FakeWebSocket` and a mocked `BackendApiClient`. These are good tests at the right level.
- **Backend contract tests:** `backend/test/*` call Fastify's `inject` through `createApp` in `server.ts`, with
  helpers such as `playRaceToEnd` and `legalMove`. They cover the API, WebSocket sync, rules, AFK and bot levels.
- **e2e:** 23 tests in 8 specs, with Chromium, the backend and the Phaser canvas.

**The gap:** `RaceScene.ts` (1282 lines) is excluded from coverage and only e2e exercises it. Here is what it does:

- the solo turn loop (`applyLocalAction` → `processBotsUntilHuman` → `playBotTurn`);
- the HUD snapshot (`emitHud`, `hudCar`, `formatTargetCost`, `makeHudText`);
- feel reactions (`reactToRace`/`reactTo`, which turn into toast and sound events);
- the "race finished" event;
- online state application (`applyBackendLobbyState`, `awaitServer`, the hold on the dropped car);
- control rules (`localCar`, `localCanControl`, `canLocalControlActiveCar`).

None of these needs Phaser. That is why most of `hud.spec.ts` and `latency.spec.ts` have to run a browser today.

## Approach

### 1. Extract a Phaser-free race session out of `RaceScene` (the main investment)

- New `src/game/race/raceSession.ts`. It holds `ctx`, `race`, the turn info, the log lines, the feel memory, the
  mode (solo or online) and `localPlayerId`. It exposes:
  - `applyLocal(action)`, which in solo applies the action and runs the bots until a human is active;
  - `applyServerState(lobby)`;
  - `localCar()` and `canControl()`;
  - `hudSnapshot(view)`, where `view` carries hover cell, screen position, overlay flags and cars/moves visibility,
    which only the scene knows;
  - `drainFeel()`, which returns the `FeelEvent`s and whether the race just finished.
- Move code; don't rewrite it. Each method body moves as is, `this.` becomes `session.`, and it reuses
  `applyAction`, `decideBotAction`, `detectFeel`, `sortCarsByProgress`, `stintEstimate`/`pitAdvice`,
  `lapInProgress` and `appendBotDecisionEntry`.
- `RaceScene` becomes a view. It calls the session, then draws tokens and targets, dispatches the `srp:hud` and
  `srp:toast` events, plays sounds and runs confetti. The `window.__srp` e2e hook reads from the session.
- Do it one slice at a time, in this order: HUD snapshot → feel/finish → solo turn loop → online state.
  Run `npm test` and the touched e2e specs after each slice. That way nothing changes behavior until the e2e specs
  that the slice replaces have been deleted.
- In `vitest.config.ts`, `src/game/scenes/**` stays excluded. The session is in `src/game/race/`, so it falls under
  the coverage thresholds automatically.

### 2. Session tests (unit and integration, jsdom, no Phaser)

`src/game/race/raceSession.test.ts`, built on the real track and `createRaceState`, as `raceEngine.test.ts` does:

- the HUD numbers follow the state after a move: lap, tire, fuel, the move cycle and the standings order;
- the stint estimate and pit chip rules, and that no chip shows early in a short race;
- lap and final-lap feel events fire for my car only, and never on the first snapshot;
- the hover cost tooltip data (distance, moveSpend, costs, squeeze);
- the turn banner fields: `activeCarId` and `canControl` across turns;
- the results: `finished` and `winnerCarId`, with a full solo race against bots played to the end through the
  session;
- online: `applyServerState` sets `myCarId`/`canControl` by seat, and the dropped car keeps its target cell while
  the server is slow (this replaces `latency.spec`; use fake timers).

Add one `session → hud.ts` integration test. It renders `renderHud(snapshot)` into jsdom and checks the DOM text
(car card, banner, standings, results table). `hud.test.ts` already does this with hand-built snapshots; the new test
covers the link between the two.

### 3. Fill the remaining page-controller gaps in `main*.test.ts` (existing harness)

- **Routing** (`flow.spec` "routing", 6 tests): back from `/solo`, reloading `/solo/race`, the confirm before leaving
  a race (stub `window.confirm`), unknown lobby notice, direct lobby link auto-join, old `?lobby=` redirect. Check
  which of these `main.test.ts` and `router.test.ts` already cover, and add only what's missing.
- **Mute persists across reloads and follows the M key** (`hud.spec`): `sound.test.ts` plus a `main.test` case.
- **AFK on the client side**: turn-timer countdown display, the host's force-skip button, and host away/back
  messages. Do this through `FakeWebSocket` messages; `afk.contract.test.ts` already covers the server side.
- **Host closes their page → the guest is warned, then sent home** (`journey.spec`): through `FakeWebSocket`.

### 4. Trim the e2e suite (delete only after its replacement is green)

| Keep (journeys and visuals)                          | Move down, then delete                                                |
| ---------------------------------------------------- | --------------------------------------------------------------------- |
| `smoke`                                              | `flow` routing ×6 → `main.test`                                       |
| `journey`: solo full race vs Hard bots + race again  | `flow` solo setup + `track` car count → `main.test`/session           |
| `flow-journey-multiplayer`: 1-lap race, play again   | `flow` "C toggles" → `carsMovesVisibility.test` exists                |
| `journey`: guest reloads mid-race and rejoins        | `flow` online lobby permissions → `main.multiplayer` + `api.contract` |
| `afk`: the host reloads mid-race, both keep racing   | `hud` ×7 (all but the screenshot) → session + hud integration         |
| `track`: drag a car to a target (real pointer input) | `latency` → session (online hold)                                     |
| `track` and `hud` screenshots                        | `afk` countdown and host skip → `main.multiplayer` + `afk.contract`   |
|                                                      | `journey` host-close warning → `main.multiplayer`                     |

The suite goes from 23 tests to about 8. Write the rule into `AGENTS.md` "Verification": _a new e2e test must
justify that it needs a real browser (a journey across pages or sockets, real pointer input, or pixels); everything
else goes in a unit, session or contract test._ Also say what each layer is for: engine/systems → session → page
controller → backend contract → e2e.

## Not doing

- Running the real backend in-process under vitest for client-to-server tests. Contract tests plus `FakeWebSocket`
  already cover both sides of the protocol. Add it only if a client/server drift bug gets through.
- Component tests of Phaser drawing. Pixels stay in the 2 screenshots.
- New dependencies. vitest, jsdom, `FakeWebSocket` and the backend helpers are enough.

## Critical files

- `src/game/scenes/RaceScene.ts` → new `src/game/race/raceSession.ts` (+ `.test.ts`)
- `src/ui/hud.ts`, `src/ui/hud.test.ts`
- `src/main.test.ts`, `src/main.multiplayer.test.ts`, `src/ui/router.test.ts`, `src/ui/sound.test.ts`
- `e2e/*.spec.ts` (deletions), `AGENTS.md`

## Verification

- After each extraction slice: `npm test`, `npm run test:coverage` (the thresholds must still hold with the session
  included), `npm run lint`, `npm run build`, and the e2e specs whose behavior the slice touches (`hud`, `track`,
  `latency`, `journey`) using the single-spec command from AGENTS.md.
- Before deleting each e2e test, temporarily break the behavior in the source (for example, fire a lap toast on the
  first snapshot) and confirm the replacement test fails.
- Final: CI full e2e on the PR (`gh run watch`). Compare the e2e wall time and test count with the current
  baseline (CI takes about 2.5 min).
