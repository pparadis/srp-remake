# Bot System

Bots for the turn-based race: three player-selectable levels (Easy, Normal, Hard) and the server's AFK
"autopilot". `decideBotAction(ctx, state, policy?)` in `src/game/race/raceEngine.ts` is the one entry point; it plays
the active car at `policy`, or at the car's own `botLevel` (default Normal) when none is passed.

## Seed, personalities and the grid

Every race carries an integer `seed` (`RaceState.seed`, `createRace(ctx, seats, laps, seed = 0)`). It is created at
the boundary, never inside the engine (no `Math.random` in `src/game` or the backend race code):

- the server rolls it with `crypto.randomInt` when a race starts (`BOT_SEED=<n>` pins it, `BOT_SEED=0` gives the
  neutral race; `playwright.config.ts` and `npm run backend:test` set 0 so the specs are deterministic);
- solo: `src/main.ts` rolls it with `crypto.getRandomValues` when "Start" is pressed; `?seed=N` in the URL pins it
  (`?seed=0` = neutral) so a race can be reproduced;
- it travels in the public race state (`raceState.seed`), in `toEngineRace` and in the "Copy debug" snapshot.

The seed decides three things, all pure functions in `src/game/systems/botStyle.ts`:

1. **Personality of each bot**: `personalityOf(seed, carId)`. A shuffled deck of the five styles per block of five
   cars, so the bots of a race differ (cars 1-5 get all five styles, car 6 starts the next deck) and each car's style
   is uniform over seeds. Humans and the autopilot have none. Seed 0 gives every bot `balanced`, which is exactly the
   old Normal bot.
2. **Grid slot of each car**: `gridSlots(seed, n)[i]` is the starting slot (0 = pole) of car `i + 1`, a seeded
   Fisher-Yates; seed 0 keeps car order. The human is no longer always on pole. `spawnCars` puts the car on the cell of
   its slot and sets its lap count from that cell (front row 0, rows behind the line -1).
3. **Play order**: `turnOrderOf(seed, n)`: the pole sitter plays first, then slot 2, ... Without it car 1 would move
   first every round wherever it starts and win every tie: equal-pace cars finish a race on the same turn, so the first
   mover wins (measured: from slot 2 of the grid the scripted strategist still won 100 % of 5-lap races). `carId`
   stays `seatIndex + 1`; the server's `activeSeatIndex` is the active car's seat (`activeSeatIndex(state)`), and the
   client rebuilds the order from the seed.

### Personalities (parameter sets in `PERSONALITIES`, applied inside the Normal scorer and the stop plan)

| Style (label)        | wearWeight | shareWeight | innerLane | laneChange | overtake | queue | block | pit gain / window                | Character                                                      |
| -------------------- | ---------- | ----------- | --------- | ---------- | -------- | ----- | ----- | -------------------------------- | -------------------------------------------------------------- |
| balanced (seed 0)    | 1          | 2           | 0         | 0          | 0        | 0     | 0     | 0 / 0                            | the pre-personality Normal bot                                 |
| Pusher               | 0.5        | 0           | 0.6       | 0          | 8        | 4     | 0     | 0 / 0                            | front-loads the cycle (9-9-9-9-4), risks tire                  |
| Steady               | 1          | 48          | 1         | -3         | 0        | 0     | 0     | 0 / 0                            | even spend (8-8-8-8-8), inner lane, few lane changes           |
| Racer                | 1          | 2           | 0.7       | +2         | 30       | 10    | 10    | 0 / 0                            | hunts positions, passes with lane changes, hates queuing       |
| Defender             | 1          | 2           | 1.2       | -8         | 0        | 0     | 14    | 0 / 0                            | holds the inner lane, sits in the lane of a rival close behind |
| Strategist (pit)     | 1          | 2           | 0.8       | 0          | 0        | 0     | 0     | early +12 / +14 or late -12 / -5 | Normal, but stops earlier or later (side from the seed)        |
| Adaptive (Hard only) | 1          | 0           | 0.6       | 0          | 0        | 0     | 0     | 0 / 0                            | Hard's own taste, see below                                    |

- `wearWeight` multiplies a move's tire+fuel cost; `shareWeight` is the points per point the remaining moves' even
  share of the 40-point cycle shrinks (a cell of progress is 10 points, so 48 forces an even spend and 0 front-loads).
- `innerLane` is the share of `LANE_SPAN` (60 points) the driver sees between the inner and the outer lane (linear):
  the inner lane has 28 cells a lap against 30 and 32, so every move is worth about 0.6 cells more per lane inward.
- `overtake` is points per car passed by the move, `queue` the penalty for ending 1-2 cells behind a car in the
  same lane (same-lane moves cannot pass it), `block` the bonus (scaled by closeness, within 6 cells) for ending in the
  lane of a rival behind.
- Pit gain/window shift `stopIsDue`: cells added to the stop's gain, and to the window of passes it may be taken in.
- Rules, BFS and lap rules are untouched: a personality only re-ranks the legal targets.

### Difficulty semantics

| Level     | Personality                                                                                                                                                      | Noise                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Easy      | follows its style sloppily: 30 % of decisions ignore it, `EASY_NOISE` (25 points = 2.5 cells) seeded noise on every score, picks the 1st/2nd/3rd best 50/30/20 % | high                 |
| Normal    | follows its style consistently                                                                                                                                   | none                 |
| Hard      | its own `adaptive` style + the lookahead + reads the field (`HARD_ADAPT`: overtake 14, queue 8, inner lane +0.3)                                                 | none                 |
| Autopilot | none (the AFK policy, unchanged)                                                                                                                                 | median-distance move |

Hard does not use its seed style: with a seeded quirky style Hard lost its edge over Normal (the quirks cost it what
the lookahead won), so it plays the fixed `adaptive` style. The standings label a Hard bot "Adaptive".

## Goals

- Provide functional AI opponents without changing core movement rules.
- Keep the bot logic deterministic and easy to test.
- Allow bots to fill empty slots or run in a dedicated bot mode.

## Non-Goals

- Learning, and search deeper than one round (tested: deeper rollouts were worse).
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

| Level     | What it does                                                                                                                                                                                                                                                                                                                                               |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Autopilot | AFK stand-in: the non-pit target closest to the median distance, current lane preferred, never pits. Deliberately mediocre; the weakest rung of the benchmark.                                                                                                                                                                                             |
| Easy      | The base score below plus its style's lane/passing taste (30 % of decisions ignore it) and seeded noise: picks the best, 2nd or 3rd target (50/30/20 %) using a PRNG (FNV-1a + mulberry32) seeded by the race seed, car id, position, lap, move cycle and resources, so it is deterministic. Wants a pit box only at 10 % (threshold 10), keeps its setup. |
| Normal    | The base score, but progress is the `forwardIndex` gain (outer lanes have cells that share an index, so cells walked over-count), plus the plan below and its personality.                                                                                                                                                                                 |
| Hard      | One round of lookahead with an opponent model on top of Normal, below.                                                                                                                                                                                                                                                                                     |

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

For the top 8 candidates by the Normal score (with Hard's `adaptive` style and `HARD_ADAPT` field terms):
`structuredClone` the race, apply the candidate with `applyAction`, play every other car with the Normal policy
(each with its own personality) until it is the Hard car's turn again, and score the position (cells of progress by
laps and `forwardIndex`):

```
value = progress(me) - 0.1 * mean(progress(rivals))
        - crawl cost (unfinished tires/fuel; a stop under way counts its fresh resources)
        + 0.1 * (Normal score - 10 * gain)      // budget cycle, wear worth, pit plan, field terms
```

A win is worth +1e6, a rival's win -1e6. How it adapts: the field terms rank candidates that pass a car with a lane
change and avoid ending right behind one; the stop is valued through the crawl it saves against the pit moves
(`PIT_LANE_CELLS`); the replies show a block it would run into. Cost: about 1.1 ms per decision with 4 cars, 2.3 ms
with 8. The server plays Hard bots with a `setImmediate` yield between turns.

What was tried and rejected (all measured on 1 120 races, 4 cars, laps 3-20, 20 seeds, Hard minus Normal in avg finish):
a "mobility" term (best forward gain at the next turn; it double counts the cycle budget and made Hard worse than
Normal, 1.60 vs 1.49), a second and third own move in the rollout (worse, the Normal self-model is wrong), 30
candidates instead of 8 (worse), a "blocked next turn" penalty (worse), `block` terms in `HARD_ADAPT` (worse), and a
seeded quirky style for Hard (0.0 to 0.07 edge instead of 0.13). Varying the pit constant 40 / -60 / 300 moved the edge
by under 0.1 (300 is worse).

**Why Hard's headroom is small**: a lone Normal car is within 1 turn of the best stop plan for every lap count (a
different stop window saves one turn at 8-9 laps only), traffic costs it 0.6 turns a race on average (41.8 solo vs
42.4 in a 4-car field) and equal-pace cars finish a race on the same turn, so the finishing order is mostly the grid
order. Hard's edge is that margin.

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

Tests: `botStyle.test.ts` (`personalityOf`, grid and play-order functions: pure, distribution), `botStyleScore.test.ts`
(what each parameter does to the scorer, Easy, Hard passing), `botSystem.test.ts` (scoring per level), `botPlan.test.ts`
(plan maths), `raceEngine.test.ts` (levels, pit planning), `botHard.test.ts`, `botLevels.test.ts` (ordering, time
guard), `botPersonalities.test.ts` (no personality dominates, the scripted strategist, seeded determinism) and the
backend `seed.contract.test.ts`. The base behaviours that still hold:

- Bot selects the furthest target when resources are healthy.
- Bot prefers pit box when resources are low.
- Bot skips only when there are no targets at all (no normal and no squeeze target).
- Bot respects `disallowPitBoxTargets` after service.

## Benchmark

```
npx tsx tools/botBench.ts [--laps 3,5,8] [--seeds 4] [--lineup hard,normal,easy,autopilot] [--styles pusher,steady,...]
npx tsx tools/botBench.ts --strategist [--laps 3,5,8] [--seeds 60] [--level normal|hard]
```

`src/game/race/botBench.ts` plays deterministic headless races: every rotation of the line-up on every lap count and
seed (the seed shuffles the grid and deals the personalities; `--styles` forces one per line-up entry instead). Cars
play until all have crossed the line. It prints per policy, per personality and per grid slot (1 = pole) win rate and
average finish (lower is better). Line-up entries `scripted` / `greedy` are the human baseline of the strategy report
(inner lane, 9-8-8-8-7, resp. the biggest move; they work their way in from the outer lane); `--strategist` plays it
from every grid slot against 3 bots.

Numbers from this version (commands above; all deterministic):

| Run                                                             | Policy    | Win rate       | Avg finish | Avg moves | ms / decision |
| --------------------------------------------------------------- | --------- | -------------- | ---------- | --------- | ------------- |
| 1 120 races, 4 cars, laps 3-12/14/16/18/20, 20 seeds            | Hard      | 54 %           | 1.48       | 43.5      | 1.1           |
|                                                                 | Normal    | 46 %           | 1.61       | 43.8      | 0.03          |
|                                                                 | Easy      | 1 %            | 2.91       | 68.7      | 0.03          |
|                                                                 | Autopilot | 0 %            | 4.00       | 96.1      | 0.02          |
| 576 races, 8 cars (2 per policy), laps 3/5/8/12/16/20, 12 seeds | Hard      | 27 % (per car) | 2.42       | 47.6      | 2.3           |
|                                                                 | Normal    | 21 %           | 2.82       | 48.1      | 0.03          |
|                                                                 | Easy      | 2 %            | 5.26       | 78.1      | 0.03          |
|                                                                 | Autopilot | 0 %            | 7.50       | 104.6     | 0.02          |

Hard beats Normal by 0.13 places in the 4-car mix (short of the 0.15 aimed for; see the list above for what was
tried) and by 0.40 in the 8-car mix. Heads-up Hard vs Normal (84 races) is decided by the grid slot, 1.54 vs 1.46: the
heads-up criterion was dropped.

Personalities, five Normal cars with one style each rotated through all seats (210 races, laps 3/4/5/6/8/10/12, 6 seeds,
the seed shuffles the grid): strategist 2.84, defender 3.01, pusher 3.04, racer 3.04, steady 3.07 average finish
(spread 0.23), win rates 17-25 % against a fair 20 %. `botPersonalities.test.ts` bounds the spread at 0.45 places
(twice the measurement) and the win rate at 30 %. The styles change how a car races (spend pattern, lanes, passes,
stops) far more than where it finishes: equal pace and the grid decide most races.

The scripted strategist (car 1; the seed gives it a random slot) against 3 Normal bots, 60 seeds:

| Laps | Before (fixed pole, `main`, 16 rotating-slot races) | After: wins | After: avg finish | After, by grid slot 1/2/3/4 |
| ---- | --------------------------------------------------- | ----------- | ----------------- | --------------------------- |
| 3    | 1st from pole                                       | 28 %        | 2.45              | 1.0 / 2.0 / 3.0 / 4.0       |
| 5    | 1st from pole (100 %)                               | 28 %        | 2.45              | 1.0 / 2.0 / 3.0 / 4.0       |
| 8    | 2nd from pole                                       | 3 %         | 3.47              | 2.7 / 3.4 / 4.0 / 3.9       |

Against Hard bots, 5 laps: 28 %, 2.45. From pole it still wins (the race is decided by the grid at 3 and 5 laps) but it is
on pole a quarter of the time; the scripted driver never pits, so from 7 laps it loses by design.

The pit-lane lap credit (PR #15, `PIT_LANE_CELLS` 40) and its effect on the older 56-race sets are in the git history
of this file.

## Future Improvements

- Per-track tuning of the pit-stop cost (`PIT_LANE_CELLS` in `botPlan.ts`).
- Lobby setting to pick a personality (the seed decides for now).

## Implementation Checklist

1. [x] Add bot identity (`isBot`) to `Car`.
2. [x] Add mode flags for bot mode + fill‑slots behavior.
3. [x] Spawn bots to fill missing slots and/or in bot mode.
4. [x] Implement `pickBotMove(...)` heuristic function.
5. [x] Integrate bot turn execution in the turn loop.
6. [x] Ensure logging and UI updates for bot actions.
7. [x] Add tests for heuristic choices and skip behavior.
