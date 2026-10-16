// A scenario is a race position: the cars where the picture puts them, built with the engine's own tools
// (createRace, the sandbox's placeCar / editCar), and read with the same entry point the game and the server use
// (computeTargets). So squeeze, pit and draft options come from the engine, and a wrong example throws.
import { createRace, computeTargets, createRaceContext, type RaceContext, type RaceState } from "../../src/game/race/raceEngine";
import { editCar, placeCar, setActiveCar, type CarEdit } from "../../src/game/race/sandbox";
import type { TargetInfo } from "../../src/game/systems/movementSystem";
import type { Car } from "../../src/game/types/car";
import type { TrackData } from "../../src/game/types/track";

export interface Scenario {
  /** the car to play ("you") */
  start: string;
  /** every other car, by cell */
  cars: string[];
  /** the move the picture is about */
  target: string;
  /** the bend to draw, first and last zone */
  zones: [number, number];
  /** state of "you" besides its cell (budget, draft run, lap, ...) */
  edit?: CarEdit;
}

export interface Position {
  ctx: RaceContext;
  state: RaceState;
  car: Car;
}

export function contextOf(track: TrackData): RaceContext {
  return createRaceContext(track);
}

/** Car 1 on `start` to play, one more car per entry of `cars`, all humans, seed 0. */
export function positionOf(ctx: RaceContext, s: Pick<Scenario, "start" | "cars" | "edit">): Position {
  const cells = [s.start, ...s.cars];
  const state = createRace(
    ctx,
    cells.map((_, i) => ({ isBot: false, ownerId: `P${i + 1}` })),
    5
  );
  cells.forEach((cell, i) => {
    // placeCar swaps with whoever stands on the cell: every car ends on its own cell, as each cell is named once
    const refused = placeCar(ctx, state, i + 1, cell);
    if (refused) throw new Error(refused);
  });
  if (s.edit) {
    const refused = editCar(ctx, state, 1, s.edit);
    if (refused) throw new Error(refused);
  }
  if (!setActiveCar(state, 1)) throw new Error("car 1 is not in the play order");
  return { ctx, state, car: state.cars.find((c) => c.carId === 1)! };
}

/** What the engine offers car 1 in this position. */
export function offeredFrom(p: Position): Map<string, TargetInfo> {
  return computeTargets(p.ctx, p.state, p.car);
}

/** The engine's entry for the scenario's target; throws when it is not offered (a wrong example). */
export function targetOf(p: Position, s: Pick<Scenario, "start" | "target">): TargetInfo {
  const info = offeredFrom(p).get(s.target);
  if (!info) throw new Error(`${s.target} is not a target from ${s.start}`);
  return info;
}
