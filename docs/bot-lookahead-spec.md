# Bot Lookahead Spec (Draft)

This document defines a future enhancement for bot decision quality using short-horizon lookahead.

## Problem

Current bot logic is single-turn heuristic scoring. It can choose moves that maximize immediate value but create poor next-turn positions (blocked lanes, weak pit timing, dead-ends).

## Goal

Improve bot move quality by evaluating the likely next turn before committing the current move.

## Scope (v1)

- 1-ply lookahead:
  - Evaluate each legal move now.
  - Simulate resulting car state.
  - Evaluate best legal move from that simulated state.
- No opponent prediction model (uses current board occupancy only).
- Deterministic behavior and stable tie-breaks.

## Non-Goals (v1)

- Multi-agent search with opponent simulation.
- Full minimax/Monte Carlo approaches.
- Learning-based policy.

## High-Level Algorithm

For each candidate move `m`:

1. Compute current move score `S_now(m)` using existing heuristic.
2. Simulate post-move state:
   - Updated `cellId`
   - Updated `tire` / `fuel`
   - Updated pit state (`pitServiced`, `pitExitBoost`, etc.)
3. Compute next-turn legal targets from simulated state.
4. Compute best next-turn score `S_next(m)` from those targets.
5. Final score:
   - `S_total(m) = S_now(m) + LOOKAHEAD_WEIGHT * S_next(m)`
6. Pick max `S_total`, then deterministic tie-breakers.

## Scoring Defaults (Draft)

- `LOOKAHEAD_WEIGHT = 0.35`
- If no next-turn move exists, `S_next = SKIP_PENALTY` (e.g. `-3`)
- Tie-breakers:
  - lower `(tireCost + fuelCost)`
  - lexicographically smaller `cellId`

## Pit Behavior

Lookahead should improve pit decisions by valuing:

- entering pit when low resources and next-turn outcome improves.
- avoiding pit entry when it harms short-term progression without survival benefit.

## API Direction

Possible extension in `botSystem`:

- `pickBotMove(targets, car, context, options)`
- `options.lookaheadEnabled`
- `options.lookaheadWeight`

or separate:

- `pickBotMoveWithLookahead(...)`

## Performance Constraints

- Must stay cheap enough for instant bot turns.
- 1-ply only to keep complexity linear in legal move count.
- Reuse precomputed track indices and existing target computation.

## Test Plan

Add regression tests for:

1. Chooses slightly worse immediate move that yields better next-turn move.
2. Avoids dead-end/skip outcome when alternative exists.
3. Pit timing improves when resources are low.
4. Deterministic result for equivalent-scoring targets.

## Rollout Plan

1. Implement behind a config flag (`lookaheadEnabled = false` by default).
2. Add unit tests and compare behavior on fixed snapshots.
3. Enable by default after validation against expected scenarios.
