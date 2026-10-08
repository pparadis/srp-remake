# Sandbox mode: place cars freely and see what the engine offers

Status: In progress (PR #29)

## Context

Rule bugs are found by playing and reported with a screenshot (the pass-and-return go-around, PR #28). Rebuilding
that position takes reading cell ids off the `F` overlay and writing a `computeValidTargets` call by hand. The owner
wants a "creative mode": put the player and the bots anywhere, look at the targets the engine offers, change the
position and look again, then play on from there.

A second goal follows from how bugs are handled now (repro first, then a verdict): every position built in the sandbox
should become a unit test with one click.

## What exists (reuse, don't rebuild)

- The engine is plain data and pure functions: `RaceState` (`cars`, `turn`, `raceLaps`, `seed`) and
  `computeTargets(ctx, state, car)` in `src/game/race/raceEngine.ts`. Moving a car is setting `car.cellId`.
- `RaceScene` already redraws from an arbitrary state: online play replaces `this.race` with the server's snapshot and
  calls `refreshAfterTurn()` (`applyBackendLobbyState`). The sandbox uses the same path after every edit.
- Drag and drop snaps a token to a cell (`findNearestCell` in `scenes/input/registerRaceSceneInputHandlers.ts`); only
  the active car can be dragged and the drop is checked against the targets (`validateMoveAttempt`).
- "Copy debug" (`scenes/debug/gameDebugSnapshot.ts`) already serialises every car (cell, lap, tire, fuel, pit state,
  setup) and the active car's targets; `?seed=N` pins the grid and play order.
- Overlays: `F` (`forwardIndex` and cell ids), `C` (cars and moves), the target markers.

## Design (solo only, `?sandbox`)

1. **Entry.** `?sandbox` on the solo URL starts a normal solo race (same settings form: cars, laps, bot level, seed)
   in edit mode. No new screen, no home-page button for now. Not in the production menu; it is a dev tool that ships.
2. **Edit mode** (toggle with `E`, and a canvas button next to Copy debug; the HUD shows "SANDBOX: editing"):
   - drag ANY car to ANY free cell, main lanes or pit lane, no rules (the drop only needs a free cell);
   - click a car to make it the active one (set `turn.index` to its slot in `turn.order`);
   - a small DOM panel (in `hud.ts`, fed by the `srp:hud` snapshot like the rest of the HUD) edits the active car:
     move points left in the cycle, lap, tire, fuel, compound, human/bot and bot level;
   - after each edit: replace the car in `this.race`, `refreshAfterTurn()`, so targets and the HUD recompute live.
3. **Play.** Leaving edit mode continues the race from that position with the normal rules: the human moves, bots
   play their turns. `E` again pauses it and returns to editing.
4. **Copy as test.** A button that copies a ready-to-paste vitest case: the occupied cells, the start cell, the move
   points, and the targets the engine offers today as `expect` lines (cell, `moveSpend`, `laneChanges`), in the style
   of `src/game/systems/passAndReturn.test.ts`. The person then edits the expectation that is wrong; that is the
   failing test the fix starts from.
5. **Load position.** "Copy debug" output pasted into a prompt (or `?pos=<base64>` in the URL) restores the cars and
   the active car, so a position can be shared in an issue or a chat.

## Not doing

- Online sandbox (the server owns the race; a host-only edit API is a bigger change, add it if online bugs need it).
- Saving positions on the server, a position library, undo/redo (copy/paste covers it).
- Editing the track.
- Any engine change: the sandbox only writes state the engine already reads.

## Risks

- `RaceScene` (about 1,300 lines) holds derived state besides `this.race` (tokens, halos, the feel memory, the turn
  banner). Edits must reset the feel memory (no lap toast or confetti from a teleported car, the same way online
  joins seed it) and respawn tokens when a car changes. The `testing-pyramid` plan (a Phaser-free race session) would
  make this cleaner, but the sandbox does not depend on it.
- Teleporting can produce states a real race never has (a car on a pit box with `pitTurnsRemaining` 0, a lap count that
  does not match the position). Allowed on purpose; the panel shows the values, and "Play" uses them as they are.

## Tests

- Unit: the edit helpers (move car, make active, set fields) on a `RaceState`, without Phaser; "Copy as test" output
  for the PR #28 position, run as a real test (it must pass as generated).
- Unit: load position round-trips the "Copy debug" snapshot.
- e2e: one spec, `?sandbox&seed=0`: drag a bot into the player's lane, check the targets change; leave edit mode and
  make one move.

## Verification

Per `AGENTS.md` "Verification": `npm test`, `npm run test:coverage`, `npm run lint`, `npm run build`, plus the new
sandbox spec only. Backend untouched.

## Result (implementation notes)

- Engine untouched. `src/game/race/sandbox.ts` (edit a car, make a car active, restore a snapshot all-or-nothing, the
  "Copy as test" text) is Phaser-free and unit-tested; the panel is `src/ui/sandboxPanel.ts` (DOM, `srp:sandbox`
  snapshots in, `srp:sandbox-command` out, like the HUD); `RaceScene` holds `sandbox` / `editing` and reuses
  `refreshAfterTurn()`. Edit mode: `processBotsUntilHuman` returns early, `recomputeTargets` shows the active car's
  targets even for a bot, every token is draggable, the rules-checked drag stands aside (`isSuspended`).
- Pressing a car (also to drag it) makes it the active one; hand the turn back with the Car select in the panel.
- After each edit the feel memory is reset, so a teleported car fires no lap toast, sound or confetti.
- "Copy debug" cars now carry `budgetLeft`, so a restore brings the move points back.
- Load position needs the same car count (all or nothing, the reason goes to the race feed). `?pos=` also sets the
  number of bots of the solo form from the position, so Quick race fits it.
- Added: "Copy link" (`?sandbox&seed=N&pos=<base64>`), the producer for `?pos=`.
- The copied test imports from `./raceEngine` and `../../../public/tracks/<trackId>.json`: paste it in `src/game/race/`.
  Verified by running a generated file as a real vitest file.
- A click on the board blurs a panel field; without it the focused field kept the `E` key.
