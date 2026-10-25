import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import bigOval from '../../../public/tracks/oval32_3lanes.json';
import { parseTrack } from '../../validation/track_schema';
import type { BotPolicy } from '../systems/bot_system';
import type { TrackData } from '../types/track';
import { playBenchRace, runBench, setupSweep, setupSweepGate } from './bot_bench';
import {
  applyAction,
  createRace,
  createRaceContext,
  decideBotAction,
  getActiveCar
} from './race_engine';

const ctx = createRaceContext(track as unknown as TrackData);

// The acceptance test of the bot levels: the same deterministic races, every policy on every grid
// slot, and the average finishing position must follow the difficulty. `npx tsx tools/bot_bench.ts`
// prints the same numbers for more races (see docs/bot-system.md).
describe('bot levels benchmark', () => {
  const lineup: BotPolicy[] = ['hard', 'normal', 'easy', 'autopilot'];
  // 4 line-up rotations x 3 race lengths x 4 seeds (personalities and grid) = 48 races; the long one needs a pit stop.
  const result = runBench(ctx, {
    lineup,
    laps: [5, 8, 12],
    seeds: [1, 2, 3, 4],
    rulesVersion: 'v2'
  });
  const avg = (policy: BotPolicy) => result.stats.get(policy)!.avgFinish;

  it('plays 48 races and every policy finishes in every one', () => {
    expect(result.races).toBe(48);
    for (const policy of lineup) expect(result.stats.get(policy)!.races).toBe(48);
  });

  it('finishes Hard ahead of Normal ahead of Easy ahead of Autopilot (lower is better)', () => {
    expect(avg('hard')).toBeLessThan(avg('normal'));
    expect(avg('normal')).toBeLessThan(avg('easy'));
    expect(avg('easy')).toBeLessThan(avg('autopilot'));
  });

  it('keeps that order on the big oval (#175)', () => {
    // rules v2, as above; no order is asserted on v3 (docs/bot-system.md has the numbers on the big oval)
    const big = runBench(createRaceContext(parseTrack(bigOval)), {
      lineup,
      laps: [5, 8],
      seeds: [1, 2, 3, 4],
      rulesVersion: 'v2'
    });
    const order = lineup.map((p) => big.stats.get(p)!.avgFinish);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 60_000); // 32 races: about 4 s plain, five times that with coverage on

  it('keeps that order on the frozen rules v1 too (#118)', () => {
    const v1 = runBench(ctx, { lineup, laps: [5, 8, 12], seeds: [1, 2, 3, 4], rulesVersion: 'v1' });
    const order = lineup.map((p) => v1.stats.get(p)!.avgFinish);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  }, 30_000);

  it('pits in a 12-lap race (a stop keeps the lap) but not in a 7-lap one, never enters the pit on the final lap', () => {
    const stops = (laps: number) => {
      const state = createRace(
        ctx,
        Array.from({ length: 4 }, (_slot, i) => ({ isBot: true, ownerId: `B${i}` })),
        laps,
        0,
        'v2'
      );
      let pits = 0;
      for (let turn = 0; turn < laps * 400 && state.winnerCarId === null; turn += 1) {
        const decision = decideBotAction(ctx, state, 'normal');
        if (decision.action.type === 'pit') pits += 1;
        // The entry is never taken on the final lap (the stop itself then happens in the next lap: the
        // crossing at the pit line is what starts it).
        const target =
          decision.action.type === 'move'
            ? ctx.cellMap.get(decision.action.targetCellId)
            : undefined;
        if (target?.tags?.includes('PIT_ENTRY')) {
          expect(getActiveCar(state).lapCount).toBeLessThan(laps - 1);
        }
        applyAction(ctx, state, decision.action);
      }
      return pits;
    };
    expect(stops(7)).toBe(0);
    expect(stops(12)).toBeGreaterThan(0);
  });

  it('is deterministic', () => {
    const again = runBench(ctx, { lineup, laps: [5], seeds: [4] });
    const first = runBench(ctx, { lineup, laps: [5], seeds: [4] });
    for (const policy of lineup) {
      expect(again.stats.get(policy)!.avgFinish).toBe(first.stats.get(policy)!.avgFinish);
    }
  });

  // Hard takes about 1.5 ms per decision with 4 cars and about 4 ms with 11 on an idle machine. Wall-clock
  // timings inflate 4x or more when the machine is busy (21 ms was measured at a load average of 70), so
  // this is a guard against an order-of-magnitude regression, not a stopwatch: the bound is deliberately loose.
  it("keeps Hard's decision time within budget", () => {
    expect(result.stats.get('hard')!.meanDecisionMs).toBeLessThan(75);
    const crowded = playBenchRace(
      ctx,
      Array.from({ length: 8 }, (_slot, i) => (i % 2 === 0 ? 'hard' : 'normal')),
      3
    );
    const { totalMs, count } = crowded.decisionMs.hard!;
    expect(totalMs / count).toBeLessThan(75);
  });
});

// Rules v3 (#148): the same ladder with the pace plan, the fuel load and the three compounds. The set is wider than
// v1's because Hard's edge over Normal is a few tenths of a place and 4 seeds left it inside the noise.
describe('bot levels benchmark on rules v3', () => {
  const lineup: BotPolicy[] = ['hard', 'normal', 'easy', 'autopilot'];
  const v3 = runBench(ctx, {
    lineup,
    laps: [5, 8, 12],
    seeds: [1, 2, 3, 4, 5, 6, 7, 8],
    rulesVersion: 'v3'
  });

  it('finishes Hard ahead of Normal ahead of Easy ahead of Autopilot (lower is better)', () => {
    const order = lineup.map((p) => v3.stats.get(p)!.avgFinish);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(order[0]).toBeLessThan(order[1]!);
  });
});

// The balance gate of the wing (issue #48): `npx tsx tools/bot_bench.ts --setups` prints the whole table.
describe('setup sweep', () => {
  const rows = setupSweep(ctx, {
    laps: [3, 4, 5, 6, 7, 8, 9, 10],
    seeds: [1, 2],
    rulesVersion: 'v2'
  });
  const gate = setupSweepGate(rows);

  it('has every wing level fastest at some race length', () => {
    expect(gate.everyWingWinsSomewhere).toBe(true);
  });

  it('has no single setup fastest at every race length', () => {
    expect(gate.noSetupDominates).toBe(true);
    // and the extremes differ: a sprint wants Low wing, a stint-length race High wing
    expect(rows[0]!.best).not.toBe(rows[rows.length - 1]!.best);
  });
});

// The same gate on rules v3, with the compounds: every compound is the fastest at some race length (soft in a sprint,
// medium in between, hard when the stint is stretched), and no setup is the fastest everywhere. A lone car: against
// traffic one seed's tow and blocking move a result by more than the gap between two setups. The wings are printed
// by the tool; Low wing wins by 0.2 moves at one length, which is tuning for the last phase of #148.
describe('setup sweep on rules v3', () => {
  const rows = setupSweep(ctx, {
    laps: [3, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
    cars: 1,
    rulesVersion: 'v3'
  });
  const gate = setupSweepGate(rows);

  it('has every compound fastest at some race length', () => {
    expect(gate.everyCompoundWinsSomewhere, gate.winners.join(', ')).toBe(true);
  });

  it('has no single setup fastest at every race length', () => {
    expect(gate.noSetupDominates).toBe(true);
    expect(rows[0]!.choices[rows[0]!.best]).not.toEqual(
      rows[rows.length - 1]!.choices[rows[rows.length - 1]!.best]
    );
  });
});
