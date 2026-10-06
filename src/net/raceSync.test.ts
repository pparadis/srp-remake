import { describe, expect, it } from "vitest";
import type { PublicRaceCar, PublicRaceState } from "./backendApi";
import { toEngineRace } from "./raceSync";

function car(carId: number, overrides: Partial<PublicRaceCar> = {}): PublicRaceCar {
  return {
    carId,
    ownerId: `P${carId}`,
    isBot: false,
    cellId: `Z0${carId}_L1_00`,
    lapCount: 1,
    tire: 80,
    fuel: 70,
    setup: { compound: "soft", psi: { fl: 23, fr: 23, rl: 21, rr: 21 }, wingFrontDeg: 6, wingRearDeg: 12 },
    state: "ACTIVE",
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

describe("toEngineRace", () => {
  const snapshot: PublicRaceState = {
    trackId: "oval16_3lanes",
    raceLaps: 4,
    turnIndex: 9,
    activeSeatIndex: 1,
    winnerCarId: null,
    cars: [car(1), car(2, { isBot: true, ownerId: "BOT2", playerId: null })]
  };

  it("keeps the engine car state and drops the seat info", () => {
    const race = toEngineRace(snapshot);

    expect(race.cars).toHaveLength(2);
    expect(race.cars[0]).toMatchObject({ carId: 1, cellId: "Z01_L1_00", tire: 80, fuel: 70, ownerId: "P1" });
    expect(race.cars[0]?.moveCycle).toEqual({ index: 2, spent: [5, 4, 0, 0, 0] });
    expect(race.cars[1]).toMatchObject({ isBot: true, ownerId: "BOT2" });
    for (const c of race.cars) {
      expect(c).not.toHaveProperty("seatIndex");
      expect(c).not.toHaveProperty("playerId");
      expect(c).not.toHaveProperty("name");
    }
  });

  it("carries a bot's level so the client engine state matches the server's", () => {
    const race = toEngineRace({
      ...snapshot,
      cars: [car(1), car(2, { isBot: true, ownerId: "BOT2", playerId: null, botLevel: "hard" })]
    });
    expect(race.cars[0]?.botLevel).toBeUndefined();
    expect(race.cars[1]?.botLevel).toBe("hard");
  });

  it("derives the turn order from the cars and the active index from the active seat", () => {
    const race = toEngineRace(snapshot);

    expect(race.turn).toEqual({ order: [1, 2], index: 1 });
    expect(race.raceLaps).toBe(4);
    expect(race.winnerCarId).toBeNull();
  });

  it("carries the winner", () => {
    expect(toEngineRace({ ...snapshot, winnerCarId: 2 }).winnerCarId).toBe(2);
  });
});
