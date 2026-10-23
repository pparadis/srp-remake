import { describe, expect, it } from 'vitest';
import track from '../../../public/tracks/oval16_3lanes.json';
import {
  applyAction,
  createRace,
  createRaceContext,
  decideBotAction,
  getActiveCar,
  type RaceAction,
  type RaceSeat
} from '../race/race_engine';
import { logAction, startRaceLog, type RaceLog } from '../race/race_log';
import type { RulesVersion } from '../rules/ids';
import type { TrackData } from '../types/track';
import { raceRecap } from './race_recap';

const ctx = createRaceContext(track as unknown as TrackData);

const SEATS: RaceSeat[] = [
  { isBot: false, ownerId: 'P1' },
  { isBot: true, ownerId: 'BOT1', botLevel: 'easy' },
  { isBot: true, ownerId: 'BOT2', botLevel: 'normal' },
  { isBot: true, ownerId: 'BOT3', botLevel: 'hard' }
];

// A race played to the end: a v3 grid setup for the human seat, which the autopilot then drives, and bots of three levels.
function playRace(rulesVersion: RulesVersion, seed: number, laps: number): RaceLog {
  const state = createRace(ctx, SEATS, laps, seed, rulesVersion);
  const log = startRaceLog(SEATS, laps, seed, rulesVersion);
  const play = (action: RaceAction) => {
    expect(applyAction(ctx, state, action).ok).toBe(true);
    logAction(log, action);
  };
  if (rulesVersion === 'v3') {
    while (getActiveCar(state).isBot) play(decideBotAction(ctx, state).action);
    play({ type: 'setup', setup: { ...state.cars[0]!.setup, compound: 'soft', fuelLoad: 80 } });
  }
  for (let i = 0; i < 2000 && state.winnerCarId === null; i += 1) {
    const car = getActiveCar(state);
    play(decideBotAction(ctx, state, car.isBot ? undefined : 'autopilot').action);
  }
  return log;
}

describe('raceRecap (#169)', () => {
  const log = playRace('v3', 3, 12);
  const recap = raceRecap(ctx, log, (id) => `Driver ${id}`);

  it('has one turn per logged action, in order, and names the cars', () => {
    expect(recap.turns).toHaveLength(log.actions.length);
    recap.turns.forEach((turn, i) => expect(turn.index).toBe(i));
    expect(recap.cars.map((c) => c.name).sort()).toEqual([1, 2, 3, 4].map((i) => `Driver ${i}`));
    expect(recap.rulesVersion).toBe('v3');
    expect(recap.raceLaps).toBe(12);
  });

  it('ranks the cars: one winner first, places and grid places are each 1..n', () => {
    expect(recap.cars.map((c) => c.place)).toEqual([1, 2, 3, 4]);
    expect(recap.cars.filter((c) => c.winner)).toHaveLength(1);
    expect(recap.cars[0]!.carId).toBe(recap.winnerCarId);
    expect(recap.cars.map((c) => c.startPlace).sort()).toEqual([1, 2, 3, 4]);
    expect(recap.cars[0]!.laps).toBeGreaterThanOrEqual(12);
  });

  it("lists each car's moves with exact move points, and its pit stops with what it chose", () => {
    const stops = recap.cars.flatMap((c) => c.pitStops);
    expect(stops.length).toBeGreaterThan(0);
    for (const car of recap.cars) {
      expect(car.moves.length).toBeGreaterThan(5);
      for (const move of car.moves) {
        expect(move.moveSpend).toBeGreaterThan(0);
        expect(move.carId).toBe(car.carId);
      }
      expect(car.pitStops).toHaveLength(car.moves.filter((m) => m.pit).length);
      for (const stop of car.pitStops) {
        expect(['hard', 'medium', 'soft']).toContain(stop.setup.compound);
        expect(stop.tireBefore).toBeLessThan(100);
        expect(stop.lap).toBeGreaterThanOrEqual(1);
      }
      // the last move leaves the car with what the race ended with
      expect(car.moves.at(-1)!.tireAfter).toBe(car.tireAtEnd);
    }
  });

  it("keeps the human's grid setup, and the bots' own", () => {
    expect(recap.cars.find((c) => !c.isBot)!.gridSetup).toMatchObject({
      compound: 'soft',
      fuelLoad: 80
    });
    expect(recap.cars.filter((c) => c.isBot).every((c) => c.botLevel !== null)).toBe(true);
    expect(recap.turns.filter((t) => t.kind === 'setup')).toHaveLength(1);
  });

  it('counts every pass once for who passed and once for who was passed', () => {
    const passes = recap.cars.reduce((sum, c) => sum + c.passes, 0);
    expect(passes).toBeGreaterThan(0);
    expect(recap.cars.reduce((sum, c) => sum + c.timesPassed, 0)).toBe(passes);
  });

  it('says the same as the live feed: a pit turn has a pit line, a pass has a pass line', () => {
    const pitTurns = recap.turns.filter((t) => t.kind === 'pit');
    expect(pitTurns.length).toBeGreaterThan(0);
    for (const turn of pitTurns) expect(turn.lines.some((l) => l.kind === 'pit')).toBe(true);
    for (const turn of recap.turns.filter((t) => (t.move?.passed.length ?? 0) > 0)) {
      expect(turn.lines.some((l) => l.kind === 'pass')).toBe(true);
    }
    expect(recap.turns.at(-1)!.lines.some((l) => l.kind === 'finish')).toBe(true);
  });

  it('works on the older rules too (no setup action, no fuel load)', () => {
    const v2 = raceRecap(ctx, playRace('v2', 2, 6));
    expect(v2.cars.map((c) => c.place)).toEqual([1, 2, 3, 4]);
    expect(v2.turns.some((t) => t.kind === 'setup')).toBe(false);
  });

  it('refuses a log with nothing in it', () => {
    expect(() => raceRecap(ctx, startRaceLog(SEATS, 1, 0, 'v3'))).toThrow(/no action/);
  });
});
