# Bot System

Bots for the turn-based race: three player-selectable levels (Easy, Normal, Hard) and the server's AFK
"autopilot". `decideBotAction(ctx, state, policy?)` in `src/game/race/raceEngine.ts` is the one entry point; it plays
the active car at `policy`, or at the car's own `botLevel` (default Normal) when none is passed.

## Goals

- Provide functional AI opponents without changing core movement rules.
- Keep the bot logic deterministic and easy to test.
- Allow bots to fill empty slots or run in a dedicated bot mode.

## Non-Goals

- Learning, and search deeper than one round.
- UI parity with player drag controls.

## Modes

- **Fill empty slots:** When player count exceeds connected humans, spawn bots to fill remaining slots.
- **Bot mode:** A dedicated mode that spawns bots (with optional single human).

## Turn Execution

- Bots **resolve moves instantly** (no drag simulation).
- Resolution uses the same movement system and validation as players.

## Levels

One level applies to every bot in a race: lobby/solo setting `botLevel` (`easy | normal | hard`, default `normal`),
stamped on each bot car as `Car.botLevel` by `createRace`. Humans have none. Timeouts and the host's force-skip
pass `"autopilot"` explicitly.

| Level     | What it does                                                                                                                                                                                                                                                               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autopilot | AFK stand-in: the non-pit target closest to the median distance, current lane preferred, never pits. Deliberately mediocre; the weakest rung of the benchmark.                                                                                                             |
| Easy      | The base score below with seeded noise: picks the best, 2nd or 3rd target (50/30/20 %) using a PRNG (FNV-1a + mulberry32) seeded by car id, position, lap, move cycle and resources, so it is deterministic. Wants a pit box only at 10 % (threshold 10), keeps its setup. |
| Normal    | The base score, but progress is the `forwardIndex` gain (outer lanes have cells that share an index, so cells walked over-count), plus the plan below.                                                                                                                     |
| Hard      | One round of lookahead with an opponent model on top of Normal, below.                                                                                                                                                                                                     |

### Normal: budget, wear and pit plan (`botPlan.ts`, `evaluateNormalTargets`)

- **Move cycle** (40 points per 5 moves): a spend that leaves budget no later move can use (more than 9 per
  remaining move) is penalised 10 points per wasted cell, and a spend above the even share of the remaining
  budget a little (2 points per point of share). Measured: front-loading is already time-optimal (the cycle total
  is fixed, and a finish is a threshold crossed mid-cycle), so the even-share term is only a tie-break; weights of
  6 or more made Normal slower, 0 to 3 are equivalent.
- **Worth of wear**: a tire or tank that will not last to the flag is worth the crawl it saves (an empty car moves
  4 instead of ~8, so every cell crawled costs a cell of time). Only a move's cost above the average wear per
  cell counts (rounding and lane factors); the average itself is paid for any progress.
- **Pit stop**: the start line crosses the pit lane, so the lap is not lost (a stop credits it at `Z01_L0_00`); a
  stop costs the lost turn and the slow one-step pit lane, about 40 cells (`PIT_LANE_CELLS`; 15 to 55 were tried,
  40 finished races fastest). `stopIsDue` compares that with the crawl it saves and stops on the last pass at the
  entry that still beats crawling; it pays from about 7 laps on fresh soft tires, solo (8 when a stop cost a lap). The entry is
  reachable only from lane 1 at one cell (the "feeder" cell, `forwardIndex` 26 on `oval16_3lanes`), so a due stop
  drifts to lane 1 and lands exactly on it; in the pit lane it takes a box.
- **Setup at a stop**: hard compound, 32 psi, wings 0. In the current cost model wings and off-32 pressure only
  add wear and the hard compound wears less than the soft one, so this is best for every race length.
- **Final lap**: never enters the pit lane. A pit-lane crossing could now finish the race, but the lane is a one-step
  crawl and the lap is not lost either way, so the rule is kept.

### Hard: lookahead with an opponent model (`botHard.ts`)

For the top 8 candidates by the Normal score: `structuredClone` the race, apply the candidate with `applyAction`,
play every other car with the Normal policy until it is the Hard car's turn again, and score the position
(cells of progress by laps and `forwardIndex`):

```
value = progress(me) - 0.3 * mean(progress(rivals)) + 0.8 * best forward gain at my next turn
        - crawl cost (unfinished tires/fuel; a stop under way counts its fresh resources)
        + 0.1 * (Normal score - 10 * gain)      // budget cycle, wear worth, pit plan
```

A win is worth +1e6, a rival's win -1e6. The lookahead sees what the greedy score cannot: a move that ends right
behind a blocker with no gap, rivals that get capped by where it stands, and the pit stop's payoff. Cost: about
1.5 ms per decision with 4 cars, 3 ms with 8, 4.5 ms with 11. The server plays Hard bots with a `setImmediate`
yield between turns.

## Bot Decision Model (base)

Bots follow a simple heuristic per turn:

1. Compute valid targets via `computeValidTargets(...)`.
2. Discard targets disallowed by game state (pit boxes disallowed after service).
3. Score remaining targets with a heuristic and choose the highest.
4. If no valid targets, bot **skips**. A boxed-in car gets squeeze targets (extra move points per car passed, see `movement-spec.md`) from `computeTargets`, so it squeezes instead of skipping (also out of a blocked pit exit); scoring is unchanged and already uses `moveSpend`.

### Base heuristic score (Easy, and the starting point of Normal)

Each candidate target receives a score:

- **Primary:** `distance` (higher is better).
- **Secondary:** prefer **lower total cost** (tireCost + fuelCost).
- **Pit preference:**
  - If tire or fuel is below a threshold, prefer `PIT_BOX` targets.
  - Otherwise, lightly penalize `PIT_BOX` targets.

Suggested defaults:

- Low resource threshold: `tire <= 25` or `fuel <= 25`
- Pit penalty when not low: `-2`
- Tie-breaker: lowest `tireCost + fuelCost`, then lowest `cellId` for determinism.

### Example Scoring (pseudo)

```
score = distance * 10 - (tireCost + fuelCost)
if isPitTrigger:
  if lowResources: score += 5
  else: score -= 2
```

## Data & State

- Bots use the same `Car` model.
- A bot is identified by a flag (e.g. `isBot: true`) or by `ownerId` prefix.
- Bot actions should be logged the same way as player actions.

## Integration Points

- **Turn flow:** on bot turn, call `computeValidTargets`, pick a target, and call `applyMove` or `recordMove(0)` to skip.
- **UI:** bot turns should still update `validTargets` and log output, but no drag input.
- **Mode selection:** add a registry flag for bot mode (e.g. `REG_BOT_MODE`).

## Testing

Tests: `botSystem.test.ts` (scoring per level), `botPlan.test.ts` (plan maths), `raceEngine.test.ts` (levels,
pit planning), `botHard.test.ts` (a position where lookahead beats greedy), `botLevels.test.ts` (benchmark).
The base behaviours that still hold:

- Bot selects the furthest target when resources are healthy.
- Bot prefers pit box when resources are low.
- Bot skips only when there are no targets at all (no normal and no squeeze target).
- Bot respects `disallowPitBoxTargets` after service.

## Benchmark

`npx tsx tools/botBench.ts [--laps 5,8,12] [--lineup hard,normal,easy,autopilot]` plays deterministic headless races
(`src/game/race/botBench.ts`; no randomness anywhere). Every rotation of the line-up is played on every lap count,
so each policy gets each grid slot (the rows behind the line start at lap count -1 and need 1-3 cells more than the front row, the
cars alternate soft and hard tires). Cars play until all have crossed the line; the crossing order is the finishing
order. Lower average finish is better.

`src/game/race/botLevels.test.ts` runs the 12-race set (4 rotations x 5/8/12 laps) and asserts
Hard < Normal < Easy < Autopilot plus Hard's time budget. Numbers from this version:

| Run                                         | Policy        | Win rate     | Avg finish | Avg moves to finish | ms / decision |
| ------------------------------------------- | ------------- | ------------ | ---------- | ------------------- | ------------- |
| 12 races (test set), 4 cars                 | Hard          | 58 %         | 1.42       | 35.1                | 1.8           |
|                                             | Normal        | 42 %         | 1.58       | 34.8                | 0.03          |
|                                             | Easy          | 0 %          | 3.00       | 46.6                | 0.04          |
|                                             | Autopilot     | 0 %          | 4.00       | 70.6                | 0.04          |
| 56 races, 4 cars, 3-20 laps                 | Hard          | 57 %         | 1.50       | 43.8                | 1.3           |
|                                             | Normal        | 43 %         | 1.61       | 43.8                | 0.03          |
|                                             | Easy          | 0 %          | 2.89       | 63.2                | 0.03          |
|                                             | Autopilot     | 0 %          | 4.00       | 94.9                | 0.02          |
| 56 races, 1 Hard vs 3 Normal                | Hard          | 29 %         | 2.30       | 42.7                | 1.4           |
|                                             | Normal (each) | 24 %         | 2.57       | 43.6                | 0.03          |
| 24 races, 8 cars (2 per policy), 3/5/8 laps | Hard          | 25 % per car | 2.75       | 22.4                | 3.0           |
|                                             | Normal        | 17 %         | 3.04       | 22.5                | 0.03          |
|                                             | Easy          | 8 %          | 4.71       | 25.7                | 0.04          |
|                                             | Autopilot     | 0 %          | 7.50       | 40.6                | 0.04          |

The laps for the 56-race rows are 3-12, 14, 16, 18 and 20.

**Effect of the pit-lane lap credit** (a stop no longer loses the lap, `PIT_LANE_CELLS` 40): the same 56 races
before the change had Hard 1.43 / Normal 1.70 / Easy 2.88 and 46.9 / 47.6 moves, so Normal gained 3.8 moves a race
and Hard 3.1; a stop now pays from about 7 laps (8 before) and bots stop more: per race Normal 0.82 -> 0.84, Hard
0.77 -> 0.91 stops over the 56 races (test set: Normal 0.42 -> 0.50, Hard 0.42 -> 0.58). Normal benefits more than
Hard (most likely because the old model's lost lap was a mistake Hard's lookahead partly corrected), so Hard's edge is smaller:
18 laps 3-20: Hard 1.49 vs Normal 1.60 (was 1.38 vs 1.72), laps 7-14: 1.41 vs 1.63 (was 1.22 vs 1.84). Pairs of
lap sets of only 12 races are noisy near that edge: of the six small sets below, 4,7,10 / 3,6,9 / 4,5,9 now put
Normal 0.1-0.2 ahead of Hard (one race moved), the others keep Hard first; Autopilot is last everywhere and Easy
third in all.

The default `botBench.ts` set (3,4,5,6 laps, 16 races) is too short and noisy to rank Hard above Normal
(1.75 vs 1.56), the sets above and the 12-race test set keep the ordering.

Other lap sets: 5,6,7 / 6,8,10 keep Hard first; 4,7,10 (1.67 vs 1.58), 3,6,9 (1.67 vs 1.58), 4,5,9 (1.67 vs 1.50)
show Normal ahead by one race. How much better Hard can be is bounded by the game: a lone Normal car is already
near the budget limit (40 per cycle), so the headroom is traffic, the pit stop and resource use, a few percent of
the race; that shows as about 1 move in 45, and as a rank edge because finishing order is decided by small gaps.

## Future Improvements

- Per-track tuning of the pit-stop cost (`PIT_LANE_CELLS` in `botPlan.ts`).
- A second round of lookahead (the 5 ms budget leaves some room; 8-11 car races are the limit).
- Different bot personalities (aggressive, conservative).

## Implementation Checklist

1. [x] Add bot identity (`isBot`) to `Car`.
2. [x] Add mode flags for bot mode + fill‑slots behavior.
3. [x] Spawn bots to fill missing slots and/or in bot mode.
4. [x] Implement `pickBotMove(...)` heuristic function.
5. [x] Integrate bot turn execution in the turn loop.
6. [x] Ensure logging and UI updates for bot actions.
7. [x] Add tests for heuristic choices and skip behavior.
