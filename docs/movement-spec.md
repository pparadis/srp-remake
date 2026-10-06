# Movement Spec (v0)

This doc summarizes the current movement rules implemented in `src/game/systems/movementSystem.ts`.
The turn flow around them (validate, apply, pit penalty, laps, winner) lives in `src/game/race/raceEngine.ts`
and is shared by single-player and the multiplayer server.

## Core Model

- Track movement uses the directed graph defined by each cell’s `next[]`.
- Valid targets are computed with BFS from the car’s current cell.
- `forwardIndex` is **not** used for movement; it is for ordering/progress only.

## Step Budget

- The active car has a max step budget (based on tires/fuel and remaining move budget).
- If the car starts in the pit lane (lane 0), the max steps are forced to `1`.
- Move spend is based on traveled distance, with `+1` surcharge for lane changes between main lanes.
- Pit-lane movement spend remains `1`.

## Costs

- Each valid target includes computed tire and fuel costs based on:
  - Distance traveled.
  - Lane factors (lane 1 is higher tire/lower fuel, lane 3 is lower tire/higher fuel).
  - Car setup (wing angles and PSI deltas vs 32).
- Costs are rounded to integers.

## Lane Change Rules

- You may only target a lane that is the same or adjacent to your start lane.
- Pit lane (lane 0) is special and handled by pit rules below.
- Lane changes must advance forward progress (no sideways moves with the same `forwardIndex`), except for `PIT_ENTRY`.

## Occupancy

- A target cell is invalid if it is occupied.
- Target-lane blocker policy:
  - For same-lane movement, the nearest occupied cell ahead is the blocker.
  - For lane changes, you may pass one blocker in the destination lane to merge into a gap.
  - Lane-change targets are blocked by the second blocker ahead in the destination lane (or by the first if only one exists).
  - Adjacent lanes do not block unless they are the chosen destination lane.
- Occupied cells are not traversable during target search (except the start cell).

## Squeeze (boxed in)

Only when an ACTIVE car has no normal target at all, `computeTargets` (raceEngine) returns squeeze targets from
`computeSqueezeTargets` instead of an empty map. When any normal target exists, squeeze is never offered.

- BFS over `next[]` up to `maxSteps` ignores occupancy for traversal, but the target cell must be free.
- Main lanes only (never PIT_ENTRY, pit lane or PIT_BOX), at most 1 lane change, `targetDelta > 0` (no backwards or pure sideways).
- `passed` = occupied main-lane cells in the start lane or the target lane (a lane counts once) with `0 < delta < targetDelta`.
  A squeeze target must have `passed >= 1`.
- `moveSpend = computeMoveSpend(...) + SQUEEZE_SURCHARGE_PER_CAR (2) * passed`, and must be `<= maxSteps`
  (remaining cycle budget / 9 cap). Tire and fuel costs stay the normal distance-based costs.
- `TargetInfo.squeezePassed` is set only for squeeze targets. Skip is legal only when there are no targets at all.

Example: car in lane 2 at forwardIndex 5, cars at 6 in lanes 1, 2 and 3. No normal target exists. Squeeze to
lane 2 at 7: distance 2, passes 1 car, move 2 + 2 = 4. To lane 1 at 7: distance 3, passes 2 cars, move 3 + 4 = 7.

## Pit Rules

- You may only enter pit via a `PIT_ENTRY` cell, and only from lane 1.
- Pit entry is only allowed at distance 1 (no multi-zone jumps into pit).
- Once in pit lane, movement is constrained by the pit chain and `maxSteps = 1` **except**:
  - If you are adjacent to a `PIT_BOX`, you may target **any** `PIT_BOX` ahead (future‑proof for longer pit lanes).
- `PIT_BOX` targets can be disallowed by options (and are disallowed after a pit stop has been serviced).
- A special “pit exit skip” can add an extra target when applicable.

## Options

- `allowPitExitSkip`: allows a computed pit-exit target when starting from a pit box.
- `disallowPitBoxTargets`: removes `PIT_BOX` cells from valid targets.

## Notes

- Movement targets are computed independently each turn.
- Any change to rules should include a unit test in `src/game/systems/movementSystem.test.ts`.
