import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import type { BotPolicy } from "../systems/botSystem";
import type { TrackData } from "../types/track";
import { playBenchRace, runBench } from "./botBench";
import { createRaceContext } from "./raceEngine";

const ctx = createRaceContext(track as unknown as TrackData);

// The acceptance test of the bot levels: the same deterministic races, every policy on every grid
// slot, and the average finishing position must follow the difficulty. `npx tsx tools/botBench.ts`
// prints the same numbers for more races (see docs/bot-system.md).
describe("bot levels benchmark", () => {
  const lineup: BotPolicy[] = ["hard", "normal", "easy", "autopilot"];
  // 4 grid rotations x 3 race lengths = 12 races; the long one needs a pit stop.
  const result = runBench(ctx, { lineup, laps: [5, 8, 12] });
  const avg = (policy: BotPolicy) => result.stats.get(policy)!.avgFinish;

  it("plays 12 races and every policy finishes in every one", () => {
    expect(result.races).toBe(12);
    for (const policy of lineup) expect(result.stats.get(policy)!.races).toBe(12);
  });

  it("finishes Hard ahead of Normal ahead of Easy ahead of Autopilot (lower is better)", () => {
    expect(avg("hard")).toBeLessThan(avg("normal"));
    expect(avg("normal")).toBeLessThan(avg("easy"));
    expect(avg("easy")).toBeLessThan(avg("autopilot"));
  });

  it("is deterministic", () => {
    const again = runBench(ctx, { lineup, laps: [5] });
    const first = runBench(ctx, { lineup, laps: [5] });
    for (const policy of lineup) expect(again.stats.get(policy)!.avgFinish).toBe(first.stats.get(policy)!.avgFinish);
  });

  // Target is about 5 ms per decision on a normal machine (about 1.5 ms measured with 4 cars, 4 ms
  // with 11); the bound leaves room for a slow CI runner.
  it("keeps Hard's decision time within budget", () => {
    expect(result.stats.get("hard")!.meanDecisionMs).toBeLessThan(15);
    const crowded = playBenchRace(ctx, Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? "hard" : "normal")), 3);
    const { totalMs, count } = crowded.decisionMs.hard!;
    expect(totalMs / count).toBeLessThan(15);
  });
});
