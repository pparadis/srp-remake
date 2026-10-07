import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import type { BotPolicy } from "../systems/botSystem";
import type { TrackData } from "../types/track";
import { playBenchRace, runBench } from "./botBench";
import { applyAction, createRace, createRaceContext, decideBotAction, getActiveCar } from "./raceEngine";

const ctx = createRaceContext(track as unknown as TrackData);

// The acceptance test of the bot levels: the same deterministic races, every policy on every grid
// slot, and the average finishing position must follow the difficulty. `npx tsx tools/botBench.ts`
// prints the same numbers for more races (see docs/bot-system.md).
describe("bot levels benchmark", () => {
  const lineup: BotPolicy[] = ["hard", "normal", "easy", "autopilot"];
  // 4 line-up rotations x 3 race lengths x 3 seeds (personalities and grid) = 36 races; the long one needs a pit stop.
  const result = runBench(ctx, { lineup, laps: [5, 8, 12], seeds: [1, 2, 3] });
  const avg = (policy: BotPolicy) => result.stats.get(policy)!.avgFinish;

  it("plays 36 races and every policy finishes in every one", () => {
    expect(result.races).toBe(36);
    for (const policy of lineup) expect(result.stats.get(policy)!.races).toBe(36);
  });

  it("finishes Hard ahead of Normal ahead of Easy ahead of Autopilot (lower is better)", () => {
    expect(avg("hard")).toBeLessThan(avg("normal"));
    expect(avg("normal")).toBeLessThan(avg("easy"));
    expect(avg("easy")).toBeLessThan(avg("autopilot"));
  });

  it("pits in a 7-lap race (a stop keeps the lap) but not in a 6-lap one, never enters the pit on the final lap", () => {
    const stops = (laps: number) => {
      const state = createRace(ctx, Array.from({ length: 4 }, (_, i) => ({ isBot: true, ownerId: `B${i}` })), laps);
      let pits = 0;
      for (let turn = 0; turn < laps * 400 && state.winnerCarId === null; turn += 1) {
        const decision = decideBotAction(ctx, state, "normal");
        if (decision.action.type === "pit") pits += 1;
        // The entry is never taken on the final lap (the stop itself then happens in the next lap: the
        // crossing at the pit line is what starts it).
        const target = decision.action.type === "move" ? ctx.cellMap.get(decision.action.targetCellId) : undefined;
        if (target?.tags?.includes("PIT_ENTRY")) expect(getActiveCar(state).lapCount).toBeLessThan(laps - 1);
        applyAction(ctx, state, decision.action);
      }
      return pits;
    };
    expect(stops(6)).toBe(0);
    expect(stops(7)).toBeGreaterThan(0);
  });

  it("is deterministic", () => {
    const again = runBench(ctx, { lineup, laps: [5], seeds: [4] });
    const first = runBench(ctx, { lineup, laps: [5], seeds: [4] });
    for (const policy of lineup) expect(again.stats.get(policy)!.avgFinish).toBe(first.stats.get(policy)!.avgFinish);
  });

  // Hard takes about 1.5 ms per decision with 4 cars and about 4 ms with 11 on an idle machine. Wall-clock
  // timings inflate 4x or more when the machine is busy (21 ms was measured at a load average of 70), so
  // this is a guard against an order-of-magnitude regression, not a stopwatch: the bound is deliberately loose.
  it("keeps Hard's decision time within budget", () => {
    expect(result.stats.get("hard")!.meanDecisionMs).toBeLessThan(75);
    const crowded = playBenchRace(ctx, Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? "hard" : "normal")), 3);
    const { totalMs, count } = crowded.decisionMs.hard!;
    expect(totalMs / count).toBeLessThan(75);
  });
});
