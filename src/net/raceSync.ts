import { turnOrderOf } from "../game/systems/botStyle";
import type { RaceState } from "../game/race/raceEngine";
import type { PublicRaceState } from "./backendApi";

// Turns the server's race snapshot into the engine state the scene renders.
// carId = seatIndex + 1; the play order follows the seed's grid, and activeSeatIndex is the active car's seat.
export function toEngineRace(raceState: PublicRaceState): RaceState {
  const cars = raceState.cars.map(({ seatIndex: _seatIndex, playerId: _playerId, name: _name, ...car }) => car);
  const order = turnOrderOf(raceState.seed, cars.length);
  return {
    cars,
    turn: { order, index: Math.max(0, order.indexOf(raceState.activeSeatIndex + 1)) },
    raceLaps: raceState.raceLaps,
    winnerCarId: raceState.winnerCarId,
    seed: raceState.seed
  };
}
