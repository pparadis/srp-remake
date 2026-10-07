import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import { personalityOf, SEEDED_STYLES, type PersonalityKey } from "../systems/botStyle";
import type { TrackData } from "../types/track";
import { playBenchRace, runBench, statsBy } from "./botBench";
import { createRace, createRaceContext, decideBotAction, applyAction } from "./raceEngine";

const ctx = createRaceContext(track as unknown as TrackData);

// The seed decides the personalities, the grid and the play order. These are the acceptance tests of
// the personalities (numbers: docs/bot-system.md, `npx tsx tools/botBench.ts --styles ...`).
describe("personalities do not dominate", () => {
  // Five Normal cars, one personality each, rotated through all five seats; the seed shuffles the grid,
  // so every personality also starts from every grid slot.
  const styles = [...SEEDED_STYLES];
  const result = runBench(ctx, {
    lineup: styles.map(() => "normal" as const),
    laps: [3, 4, 5, 6, 8, 10, 12],
    seeds: [1, 2, 3, 4, 5, 6],
    styles
  });
  const byStyle = statsBy(result.results, (f) => f.style);
  const finishes = styles.map((style) => byStyle.get(style)!.avgFinish);

  it("plays 210 races with every personality in every one", () => {
    expect(result.races).toBe(210);
    for (const style of styles) expect(byStyle.get(style)!.races).toBe(210);
  });

  // Measured spread between the best and the worst personality: about 0.2 places (1st to 5th is 4). The
  // bound is twice that: it ignores tuning noise but fails if one style becomes a clear winner or loser.
  it("keeps the average finish of the best and worst personality within 0.45 places", () => {
    expect(Math.max(...finishes) - Math.min(...finishes)).toBeLessThan(0.45);
  });

  // With the grid shuffled a fair share is 20 % (measured 17-22 %); the cap is 1.5x that.
  it("lets no personality win more than 30 % of the 5-car races", () => {
    for (const style of styles) expect(byStyle.get(style)!.winRate).toBeLessThan(0.3);
  });

  it("also holds in 4-car races with the same line-up of four styles", () => {
    const four: PersonalityKey[] = ["pusher", "steady", "racer", "defender"];
    const r = runBench(ctx, { lineup: four.map(() => "normal" as const), laps: [3, 5, 8, 12], seeds: [1, 2, 3, 4, 5, 6], styles: four });
    const stats = statsBy(r.results, (f) => f.style);
    for (const style of four) expect(stats.get(style)!.winRate).toBeLessThan(0.4);
  });
});

describe("the scripted strategist is no longer a guaranteed win", () => {
  // Human baseline of the user's report: always the inner lane, 9-8-8-8-7. It is car 1, but the seed
  // gives it a random grid slot (and play order), against 3 Normal bots with seeded personalities.
  const seeds = Array.from({ length: 48 }, (_, i) => i + 1);
  const races = (laps: number) =>
    seeds.map((seed) => playBenchRace(ctx, ["scripted", "normal", "normal", "normal"], laps, seed).finishers.find((f) => f.slot === 0)!);

  it("wins about its fair quarter of 5-lap races, not all of them (it won 100 % from pole before the seeded grid)", () => {
    const me = races(5);
    const winRate = me.filter((f) => f.place === 1).length / me.length;
    const avg = me.reduce((sum, f) => sum + f.place, 0) / me.length;
    expect(winRate).toBeGreaterThan(0.15);
    expect(winRate).toBeLessThan(0.5);
    expect(avg).toBeGreaterThan(2.0);
    expect(avg).toBeLessThan(3.0);
  });

  it("is still decided largely by where the grid puts it: pole wins, last place is last", () => {
    const me = races(3);
    const from = (grid: number) => me.filter((f) => f.grid === grid);
    expect(from(0).length).toBeGreaterThan(5);
    expect(from(0).every((f) => f.place === 1)).toBe(true);
    expect(from(3).every((f) => f.place >= 3)).toBe(true);
  });
});

describe("seeded races", () => {
  const play = (seed: number) => {
    const state = createRace(
      ctx,
      Array.from({ length: 4 }, (_, i) => ({ isBot: true, ownerId: `BOT${i + 1}`, botLevel: "normal" as const })),
      4,
      seed
    );
    const moves: string[] = [];
    while (state.winnerCarId === null && moves.length < 400) {
      const decision = decideBotAction(ctx, state);
      moves.push(JSON.stringify(decision.action));
      applyAction(ctx, state, decision.action);
    }
    return { state, moves };
  };

  it("replays identically for the same seed", () => {
    const a = play(1234);
    const b = play(1234);
    expect(b.moves).toEqual(a.moves);
    expect(JSON.stringify(b.state)).toBe(JSON.stringify(a.state));
  });

  const gridOf = (seed: number) =>
    createRace(ctx, [1, 2, 3].map((i) => ({ isBot: true, ownerId: `BOT${i}` })), 1, seed).cars.map((c) => c.cellId).join();

  it("differs between seeds: personalities, grid and the race itself", () => {
    const seeds = Array.from({ length: 12 }, (_, i) => i + 1);
    expect(new Set(seeds.map((seed) => play(seed).moves.join("|"))).size).toBeGreaterThan(4);
    expect(new Set(seeds.map(gridOf)).size).toBeGreaterThan(2);
    expect(new Set(seeds.map((seed) => personalityOf(seed, 1).key)).size).toBeGreaterThan(2);
    expect(new Set([0, 0, 0].map(gridOf)).size).toBe(1); // seed 0 keeps the fixed grid
  });

  it("gives every car the lap count of the grid cell it really starts on", () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const state = createRace(ctx, Array.from({ length: 5 }, (_, i) => ({ isBot: false, ownerId: `P${i}` })), 3, seed);
      for (const car of state.cars) {
        const fwd = ctx.cellMap.get(car.cellId)!.forwardIndex;
        expect(car.lapCount).toBe(fwd > 0 ? -1 : 0);
      }
    }
  });
});
