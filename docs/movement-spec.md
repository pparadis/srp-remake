# Movement Spec (v0)

This doc summarizes the current movement rules implemented in `src/game/systems/movementSystem.ts`.

## Core Model

- Track movement uses the directed graph defined by each cell’s `next[]`.
- Valid targets are computed with BFS from the car’s current cell.
- `forwardIndex` is **not** used for movement; it is for ordering/progress only.

## Step Budget

- The active car has a max step budget (based on tires/fuel and remaining move budget).
- If the car starts in the pit lane (lane 0), the max steps are forced to `1`.

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
- Passing is **blocked only by cars ahead in the target lane**:
  - For each lane, compute the nearest occupied cell **ahead** of the start position (by `forwardIndex` delta).
  - A target in that lane is invalid if it would move past that nearest occupied cell.
- Adjacent lanes **do not** block lane changes; this allows overtakes when the target lane is clear.

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
