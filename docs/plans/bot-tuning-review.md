# Review the bot tuning after the passing rule changes

Status: Planned

## Context

Passing got easier in two steps: #28 (a pass-and-return may pass one car in the lane it goes round through) and #30 (a
lane change may pass the only car in its destination lane, so it is stopped by the second car only). Bots read the same
targets, so they overtake more. Benchmark on `main` before and after #30 (`npx tsx tools/botBench.ts --seeds 30
--laps 3,5,8`, 360 races, average finish, 1 = best):

| policy | before #30 | after #30 | wins before -> after |
| ------ | ---------- | --------- | -------------------- |
| Hard   | 1.54       | 1.56      | 192 -> 187           |
| Normal | 1.71       | 1.63      | 142 -> 156           |

Easy and Autopilot barely moved. The ordering Hard < Normal < Easy < Autopilot still holds (asserted by
`src/game/race/botLevels.test.ts`), but Hard's lead over Normal shrank from 0.17 to 0.07 places. The owner has not
decided whether that matters.

## Questions to answer

1. Is a 0.07 gap between Hard and Normal enough? What should "Hard" feel like next to "Normal" for a human player?
2. Does Hard use the new passes (a pass through the middle lane past a lone car, a go-around that passes a car in the
   adjacent lane)? The scoring may still treat the higher move spend of a lane change as a cost it does not need to pay.
3. Do the personalities (`botStyle.ts`) still balance? `botPersonalities.test.ts` guards that none dominates; check the
   table of win rate per personality and per grid slot (pole advantage) before and after.
4. How does the scripted human baseline (`--strategist`) fare against each level now?

## Approach

1. Measure first, change nothing: the same benchmark on a wider set (laps 3/5/8/12, 8 cars, 30+ seeds), the per-slot
   and per-personality tables, and `--strategist` against Easy/Normal/Hard. Put the numbers in this plan.
2. If Hard's lead is too small, look at `botHard.ts` and `botPlan.ts` for terms that undervalue a go-around or a lane
   change now that more of them are legal (the move-spend cost, the cap on a go-around's price), and tune with the
   benchmark as the judge. Keep the engine rules as they are: the bots follow the rules, not the other way round.
3. Keep `Hard < Normal < Easy < Autopilot` and the personalities test green; record the final numbers in
   `docs/bot-system.md`.

## Not doing

- Changing the passing rules back to widen the gap: the rule fix (#30) was a consistency fix, not a balance knob.
- A new bot level or a new personality.

## Verification

Per `AGENTS.md` "Verification" and "Bots": `npm test`, `npm run lint`, `npm run build`, and the benchmark after any
change to `botSystem.ts`, `botPlan.ts` or `botHard.ts`, reporting before and after. No e2e unless a UI change comes with it.
