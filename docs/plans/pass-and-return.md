# Pass and return: go around a blocker and rejoin your lane in one move

Status: Planned (decided with the owner, not started; build it after the bot-personalities PR #19 merges)

## Context

Found by playing, reported with a screenshot. The player's car is on `Z20_L1_00` (inner lane) and car 11 is on
`Z23_L1_00`, three cells ahead in the same lane. The engine offers:

- lane 1: only `Z21` and `Z22` (the two cells before car 11);
- lane 2: cells all the way out to distance 9;
- lane 3: none.

The player expected to be able to go around car 11 through lane 2 and land back in lane 1 in front of it. Today they
can do it in two turns (move into lane 2 past the car; next turn lane-1 cells ahead are offered, because car 11 is
then behind). In one move they cannot, because of this rule in `computeValidTargets`
(`src/game/systems/movementSystem.ts`): a target in your own lane cannot be beyond the nearest car ahead in that lane,
whatever route would get you there. The route is never looked at, only the target lane's blockers.

Related finding (why the pricing matters): the move search walks the track graph, where a lane change is just another
edge, and the only lane limit is on the final cell (it must be within 1 lane of the start). So zig-zags that end in the
start lane or 2 lanes away are already legal in rare cases: in 814 simulated bot turns (4, 8 and 11 cars), 19 turns
(2.3 %) offered 60 targets that need 2 or more lane changes (13 with two changes, 47 with three). Their price is not
per lane change:

- `computeMoveSpend` (`src/game/systems/moveBudgetSystem.ts`) charges the cells walked, plus 1 only when the start lane
  differs from the end lane and the forward gain is at least the distance. A move that goes out and back (start lane =
  end lane) pays no lane-change surcharge at all.
- 44 of the 47 three-lane-change targets were priced lower than "forward cells + one point per lane change".

## Decisions (owner)

1. Allow it: a target in your own lane beyond the nearest blocker becomes legal when a free route goes around the blocker
   through an adjacent lane. This fixes the screenshot case.
2. Price: **every lane change costs +1 move point** on top of the cells walked, so out and back costs +2. This applies
   to the rare zig-zags that are already legal as well.
3. Zig-zags stay legal as long as the price is consistent. "Only one sideways move per move" is NOT a rule (the owner
   considered it and changed their mind); do not enforce it.
4. Ordinary single lane changes keep exactly today's price (no behaviour change for regular play).

## Approach

1. **Pricing first, as a property.** Define the price of a path as cells walked + one point per lane change that is not
   already paid by a walked step with no forward progress (today's single-change prices already satisfy "+1 per lane
   change": a diagonal lane change pays the surcharge, a lane change that uses a sideways step pays it as the extra
   walked cell). Write it down in `docs/movement-spec.md`. Add a test that, over simulated races, every target with at
   most one lane change keeps exactly its current price, and that targets with 2 or more lane changes pay +1 for each.
2. **Search by price, not only by distance.** `computeValidTargets` does a BFS by distance; the cheapest legal path to a
   cell is no longer always the shortest one once lane changes cost. Track the best (price, lane changes) per cell
   (a small Dijkstra, or BFS with a lane-change count in the state), keep the walked distance for the wear costs
   (`computeCosts` stays distance-based), and keep the budget cap on the price (`moveSpend <= maxSteps`).
3. **Relax the same-lane blocker rule only for routes that go around.** A same-lane target beyond the nearest same-lane
   blocker is legal iff there is a legal route to it that leaves the lane and rejoins it. Decide and document, with
   tests, how the existing rules apply to each leg of the route: occupied cells stay non-traversable, each lane change
   must advance `forwardIndex` (no pure sideways target), and the existing lane-change blocker rule (cannot pass the
   second blocker in the lane you move into) applies to the intermediate lane. Do not add an explicit cap on the number
   of lane changes (the budget is the cap).
4. **Squeeze interplay.** Squeeze only applies when there is no normal target; with this rule fewer cars are boxed in.
   Re-check the squeeze tests and the boxed-in frequency script and keep both rules consistent.
5. **UI.** Reuse the existing targets. If a target needs 2 or more lane changes, say so in the hover tooltip
   (for example "(2 lane changes)") so the price is explainable. No layout change.
6. **Bots.** `decideBotAction` reads `computeTargets`, so bots see the new targets automatically. Re-run the benchmark and
   check the scoring still prices them sensibly (the higher move spend feeds the budget terms).

## Tests

- The screenshot position as a unit test on the real track: car on `Z20_L1_00`, another car on `Z23_L1_00`; assert the
  lane-1 cells beyond it are now offered, with their prices (cells walked + 2), and that nothing changes for a
  position where no blocker is in your lane.
- The pricing property tests from step 1; a zig-zag price consistency test; an unblocked lane change keeps its price.
- Engine tests: apply a pass-and-return move, check the cell, the recorded spend, the tire and fuel costs (distance
  based), the turn advance, and that the move validates through `validateMoveAttempt` on the server path.
- A simulated-races check that no target is cheaper than "forward + lane changes" and that boxed-in turns do not
  increase.

## Verification

- Per `AGENTS.md` "Verification": `npm test`, `npm run test:coverage`, `npm run lint`, `npm run build`,
  `npm run backend:test`, `npm run backend:build`; locally run only the e2e specs the change touches (probably none:
  the rule is engine-level); CI runs the full suite and the 2 shards, watched with `gh run watch`.
- Bot benchmark (`npx tsx tools/botBench.ts`, several lap sets and the 8-car mix, with `--seeds`): the ordering
  Hard < Normal < Easy < Autopilot must still hold, the personalities test (no single style dominates) must still
  pass, and the scripted strategist baseline (`--strategist`) is re-measured. Easier passing should weaken the leader's
  advantage; report the before and after numbers.

## Not doing

- Enforcing "one lane change per move" (decision 3).
- Changing the price of ordinary single lane changes (decision 4).
- Lane-length fairness (lanes have 28 / 30 / 32 cells; charging by forward gain is a separate, open audit item).

## Where to start

Branch from `main` after #19 (bot personalities) merges, so the benchmark baseline includes the personalities; a stacked
PR on `feat/bot-personalities` also works (it retargets to `main` when #19 merges). Files: `src/game/systems/movementSystem.ts`
(`computeValidTargets`, the blocker logic, `computeSqueezeTargets`), `src/game/systems/moveBudgetSystem.ts`
(`computeMoveSpend`), their tests, `docs/movement-spec.md`, `AGENTS.md` "Key Rules".
