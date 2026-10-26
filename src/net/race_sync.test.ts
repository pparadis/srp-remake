import { describe, expect, it } from 'vitest';
import type { PublicRaceCar, PublicRaceState } from './backend_api';
import { turnOrderOf } from '../game/systems/bot_style';
import { toEngineRace } from './race_sync';

function car(carId: number, overrides: Partial<PublicRaceCar> = {}): PublicRaceCar {
  return {
    carId,
    ownerId: `P${carId}`,
    isBot: false,
    cellId: `Z0${carId}_L1_00`,
    lapCount: 1,
    tire: 80,
    fuel: 70,
    setup: { compound: 'soft', psi: { fl: 23, fr: 23, rl: 21, rr: 21 }, wing: 'medium' as const },
    state: 'ACTIVE',
    pitTurnsRemaining: 0,
    pitExitBoost: false,
    pitServiced: false,
    moveCycle: { index: 2, spent: [5, 4, 0, 0, 0] },
    seatIndex: carId - 1,
    playerId: `player-${carId}`,
    name: `Driver ${carId}`,
    ...overrides
  };
}

describe('toEngineRace', () => {
  const snapshot: PublicRaceState = {
    trackId: 'oval16_3lanes',
    raceLaps: 4,
    turnIndex: 9,
    activeSeatIndex: 1,
    winnerCarId: null,
    seed: 0,
    cars: [car(1), car(2, { isBot: true, ownerId: 'BOT2', playerId: null })]
  };

  it('keeps the engine car state and drops the seat info', () => {
    const race = toEngineRace(snapshot);

    expect(race.cars).toHaveLength(2);
    expect(race.cars[0]).toMatchObject({
      carId: 1,
      cellId: 'Z01_L1_00',
      tire: 80,
      fuel: 70,
      ownerId: 'P1'
    });
    expect(race.cars[0]?.moveCycle).toEqual({ index: 2, spent: [5, 4, 0, 0, 0] });
    expect(race.cars[1]).toMatchObject({ isBot: true, ownerId: 'BOT2' });
    for (const c of race.cars) {
      expect(c).not.toHaveProperty('seatIndex');
      expect(c).not.toHaveProperty('playerId');
      expect(c).not.toHaveProperty('name');
    }
  });

  it("carries a bot's level so the client engine state matches the server's", () => {
    const race = toEngineRace({
      ...snapshot,
      cars: [car(1), car(2, { isBot: true, ownerId: 'BOT2', playerId: null, botLevel: 'hard' })]
    });
    expect(race.cars[0]?.botLevel).toBeUndefined();
    expect(race.cars[1]?.botLevel).toBe('hard');
  });

  it("takes the play order from the server's state, the active index from the active seat (#138)", () => {
    const race = toEngineRace({ ...snapshot, turnOrder: [2, 1] });

    expect(race.turn).toEqual({ order: [2, 1], index: 0 });
  });

  it("falls back to the seed's grid order from a server that does not send it", () => {
    const race = toEngineRace(snapshot);

    expect(race.turn).toEqual({ order: [1, 2], index: 1 });
    expect(race.raceLaps).toBe(4);
    expect(race.winnerCarId).toBeNull();
  });

  it("carries the seed and plays the pole sitter of the seeded grid first, with the active seat's car at the index", () => {
    const four: PublicRaceState = {
      ...snapshot,
      seed: 5,
      activeSeatIndex: 2,
      cars: [1, 2, 3, 4].map((id) => car(id))
    };
    const race = toEngineRace(four);
    expect(race.seed).toBe(5);
    expect(race.turn.order).toEqual(turnOrderOf(5, 4));
    expect([...race.turn.order].sort()).toEqual([1, 2, 3, 4]);
    expect(race.turn.order[race.turn.index]).toBe(3); // seat 2 = car 3
  });

  it('carries the rules the server plays, and none from a server that predates the field (#148)', () => {
    expect(toEngineRace({ ...snapshot, rulesVersion: 'v3' }).rulesVersion).toBe('v3');
    expect(toEngineRace(snapshot).rulesVersion).toBeUndefined();
  });

  it('carries the winner', () => {
    expect(toEngineRace({ ...snapshot, winnerCarId: 2 }).winnerCarId).toBe(2);
  });
});
