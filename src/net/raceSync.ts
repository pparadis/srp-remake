import type { RaceState } from "../game/race/raceEngine";
import type { PublicRaceState } from "./backendApi";

// Turns the server's race snapshot into the engine state the scene renders.
// carId = seatIndex + 1, so the turn order is the car order.
export function toEngineRace(raceState: PublicRaceState): RaceState {
  const cars = raceState.cars.map(({ seatIndex: _seatIndex, playerId: _playerId, name: _name, ...car }) => car);
  return {
    cars,
    turn: { order: cars.map((car) => car.carId), index: raceState.activeSeatIndex },
    raceLaps: raceState.raceLaps,
    winnerCarId: raceState.winnerCarId
  };
}
