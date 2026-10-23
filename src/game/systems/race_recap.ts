// The recap of a finished race (#169), built from its action log: per car (setup, pit choices, moves) and per turn.
// Pure, no Phaser. Every number comes from replaying the log, so solo and online, bots and humans, all say the same,
// and the move points are exact (the live HUD only knows them while the car's move cycle has not rolled over).
import { computeTargets, type RaceContext } from '../race/race_engine';
import { replaySteps, type RaceLog } from '../race/race_log';
import { must } from '../must';
import type { BotLevel, Car, CarSetup } from '../types/car';
import { feedLines, type FeedLine } from './race_feed';
import { lapInProgress } from './lap_progress';
import { rankPosition } from './track_index';

/** What a car chose at a pit stop, and what it had left when it came in. */
export interface PitChoice {
  /** The turn (index in the log) of the stop. */
  turn: number;
  /** The lap in progress. */
  lap: number;
  setup: CarSetup;
  tireBefore: number;
  fuelBefore: number;
}

export interface RecapMove {
  turn: number;
  carId: number;
  /** The lap in progress when the move ended. */
  lap: number;
  fromCellId: string;
  toCellId: string;
  fromLane: number;
  toLane: number;
  /** Cells gained along the lap (lap position, any lane); 0 for a pit stop's walk. */
  cells: number;
  /** Move points spent (the engine's price: cells walked plus lane changes). */
  moveSpend: number;
  tireUsed: number;
  fuelUsed: number;
  tireAfter: number;
  fuelAfter: number;
  /** The cars it passed on this move. */
  passed: number[];
  squeeze: boolean;
  slingshot: boolean;
  /** It ended in another car's tow. */
  tow: boolean;
  /** Its place after the move. */
  place: number;
  pit: PitChoice | null;
}

export interface RecapTurn {
  /** Index in the race log: the n-th accepted action. */
  index: number;
  carId: number;
  kind: 'move' | 'pit' | 'setup' | 'skip';
  /** What the feed said about it (the same lines as the live feed). */
  lines: FeedLine[];
  move: RecapMove | null;
}

export interface CarRecap {
  carId: number;
  name: string;
  isBot: boolean;
  botLevel: BotLevel | null;
  /** Final place: the winner first, then by distance covered. */
  place: number;
  /** Place on the grid. */
  startPlace: number;
  winner: boolean;
  /** Laps completed. */
  laps: number;
  /** The setup the car started its first move with. */
  gridSetup: CarSetup;
  pitStops: PitChoice[];
  moves: RecapMove[];
  /** Cars it passed, and times it was passed. */
  passes: number;
  timesPassed: number;
  tows: number;
  slingshots: number;
  squeezes: number;
  tireAtEnd: number;
  fuelAtEnd: number;
}

export interface RaceRecap {
  raceLaps: number;
  rulesVersion: string;
  winnerCarId: number | null;
  cars: CarRecap[];
  turns: RecapTurn[];
}

/** Builds the recap of `log`; `nameOf` gives a car its name (the log only holds seats). Throws if the log does not replay. */
export function raceRecap(
  ctx: RaceContext,
  log: RaceLog,
  nameOf: (carId: number) => string = (carId) => `Car ${carId}`
): RaceRecap {
  const { trackIndex, cellMap } = ctx;
  const progress = (car: Car) =>
    (car.lapCount ?? 0) * trackIndex.spineLen +
    rankPosition(trackIndex, must(cellMap.get(car.cellId), 'cell of a car'));
  const steps = replaySteps(ctx, log);
  const grid = steps[0]?.before;
  if (!grid) throw new Error('A race log with no action has no recap.');
  const placeOf = (cars: Car[], car: Car) =>
    1 + cars.filter((c) => progress(c) > progress(car)).length;
  const carsById = new Map<number, CarRecap>(
    grid.cars.map((car) => [
      car.carId,
      {
        carId: car.carId,
        name: nameOf(car.carId),
        isBot: car.isBot,
        botLevel: car.isBot ? (car.botLevel ?? 'normal') : null,
        place: 0,
        // the play order starts with the pole sitter, and the front row would otherwise tie on distance
        startPlace: grid.turn.order.indexOf(car.carId) + 1,
        winner: false,
        laps: 0,
        gridSetup: car.setup,
        pitStops: [],
        moves: [],
        passes: 0,
        timesPassed: 0,
        tows: 0,
        slingshots: 0,
        squeezes: 0,
        tireAtEnd: car.tire,
        fuelAtEnd: car.fuel
      }
    ])
  );
  const recapOf = (carId: number) => must(carsById.get(carId), 'car of the recap');
  const moved = new Set<number>();
  const turns: RecapTurn[] = [];

  steps.forEach(({ action, before, after, result }, index) => {
    const car = must(
      after.cars.find((c) => c.carId === result.carId),
      'car that played'
    );
    const prev = must(
      before.cars.find((c) => c.carId === result.carId),
      'car that played, before'
    );
    const lines = feedLines(ctx, before, after, (c) => nameOf(c.carId));
    const entry = recapOf(car.carId);
    if (action.type === 'setup') {
      // the setup the car starts its first move with is the last one chosen on the grid
      if (!moved.has(car.carId)) entry.gridSetup = car.setup;
      turns.push({ index, carId: car.carId, kind: 'setup', lines, move: null });
      return;
    }
    if (action.type === 'skip' && car.cellId === prev.cellId) {
      turns.push({ index, carId: car.carId, kind: 'skip', lines, move: null });
      return;
    }

    moved.add(car.carId);
    const from = must(cellMap.get(prev.cellId), 'cell the car moved from');
    const to = must(cellMap.get(car.cellId), 'cell the car moved to');
    const pit = action.type === 'pit';
    const passed = after.cars
      .filter(
        (c) =>
          c.carId !== car.carId &&
          progress(
            must(
              before.cars.find((b) => b.carId === c.carId),
              'car before'
            )
          ) > progress(prev) &&
          progress(c) < progress(car)
      )
      .map((c) => c.carId);
    const slingshot = (car.slingshots ?? 0) > (prev.slingshots ?? 0);
    const squeeze =
      !pit && computeTargets(ctx, before, prev).get(car.cellId)?.squeezePassed !== undefined;
    const choice: PitChoice | null = pit
      ? {
          turn: index,
          lap: lapInProgress(car.lapCount, after.raceLaps),
          setup: structuredClone(car.setup),
          tireBefore: prev.tire,
          fuelBefore: prev.fuel
        }
      : null;
    const move: RecapMove = {
      turn: index,
      carId: car.carId,
      lap: lapInProgress(car.lapCount, after.raceLaps),
      fromCellId: prev.cellId,
      toCellId: car.cellId,
      fromLane: from.laneIndex,
      toLane: to.laneIndex,
      cells: pit ? 0 : Math.round(progress(car) - progress(prev)),
      moveSpend: result.moveSpend,
      tireUsed: pit ? 0 : Math.max(0, prev.tire - car.tire),
      fuelUsed: pit ? 0 : Math.max(0, prev.fuel - car.fuel),
      tireAfter: car.tire,
      fuelAfter: car.fuel,
      passed,
      squeeze,
      slingshot,
      tow: (car.draftTurns ?? 0) > 0,
      place: placeOf(after.cars, car),
      pit: choice
    };
    entry.moves.push(move);
    if (choice) entry.pitStops.push(choice);
    entry.passes += passed.length;
    for (const id of passed) recapOf(id).timesPassed += 1;
    if (move.tow) entry.tows += 1;
    if (slingshot) entry.slingshots += 1;
    if (squeeze) entry.squeezes += 1;
    turns.push({ index, carId: car.carId, kind: pit ? 'pit' : 'move', lines, move });
  });

  const end = must(steps.at(-1), 'last step').after;
  // The winner first (the first across the line), then by distance covered.
  const finishing = [...end.cars].sort((a, b) =>
    a.carId === end.winnerCarId ? -1 : b.carId === end.winnerCarId ? 1 : progress(b) - progress(a)
  );
  finishing.forEach((car, i) => {
    const entry = recapOf(car.carId);
    entry.place = i + 1;
    entry.winner = car.carId === end.winnerCarId;
    entry.laps = Math.max(0, car.lapCount ?? 0);
    entry.tireAtEnd = car.tire;
    entry.fuelAtEnd = car.fuel;
  });
  return {
    raceLaps: end.raceLaps,
    rulesVersion: log.rulesVersion,
    winnerCarId: end.winnerCarId,
    cars: [...carsById.values()].sort((a, b) => a.place - b.place),
    turns
  };
}
