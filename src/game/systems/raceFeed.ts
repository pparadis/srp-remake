// The race feed (#92): what the cars did between two race states, as lines for the HUD. Pure, no Phaser; solo calls
// it after each action and online after each server state, so both say the same things. It reads the difference
// between the states, so a state that carries several turns is said once, as one change.
import { computeTargets, type RaceContext, type RaceState } from '../race/raceEngine';
import type { Car } from '../types/car';
import { lapInProgress } from './lapProgress';
import { rankPosition } from './trackIndex';

export type FeedKind = 'move' | 'pass' | 'lap' | 'pit' | 'warn' | 'finish' | 'info';

export interface FeedLine {
  text: string;
  kind: FeedKind;
  /** The car the line is about (the HUD marks the local player's own). */
  carId?: number;
}

/** Below this a tire or the fuel is "low" (the HUD's crit level). */
const LOW_PERCENT = 20;

/** The cars whose cell differs, in the order they moved in: turn order, starting with the car on turn in `before`. */
export function carsMovedInOrder(before: RaceState, after: RaceState): Car[] {
  const { order, index } = before.turn;
  const rank = (carId: number) => {
    const at = order.indexOf(carId);
    return at < 0 ? order.length : (at - index + order.length) % order.length;
  };
  return after.cars
    .filter((car) => before.cars.find((c) => c.carId === car.carId)?.cellId !== car.cellId)
    .sort((a, b) => rank(a.carId) - rank(b.carId));
}

export function feedLines(
  ctx: RaceContext,
  before: RaceState,
  after: RaceState,
  name: (car: Car) => string
): FeedLine[] {
  const { cellMap, trackIndex } = ctx;
  const lines: FeedLine[] = [];
  const say = (kind: FeedKind, car: Car, text: string) =>
    lines.push({ kind, carId: car.carId, text });
  const progress = (car: Car) =>
    (car.lapCount ?? 0) * trackIndex.spineLen + rankPosition(trackIndex, cellMap.get(car.cellId)!);
  const place = (state: RaceState, car: Car) =>
    1 + state.cars.filter((c) => progress(c) > progress(car)).length;
  const was = (car: Car) => before.cars.find((c) => c.carId === car.carId);
  const onTurn = before.cars.find((c) => c.carId === before.turn.order[before.turn.index]);
  const turnPassed =
    after.winnerCarId !== before.winnerCarId || after.turn.index !== before.turn.index;

  for (const car of carsMovedInOrder(before, after)) {
    const prev = was(car);
    if (!prev) continue;
    const from = cellMap.get(prev.cellId)!;
    const to = cellMap.get(car.cellId)!;
    const label = name(car);
    if (car.tire > prev.tire || car.fuel > prev.fuel) {
      say(
        'pit',
        car,
        `${label} pits: ${car.setup.compound} tires, ${car.setup.wing} wing, full tank`
      );
    } else {
      const cells = Math.round(progress(car) - progress(prev));
      const lane =
        from.laneIndex !== to.laneIndex ? `lane ${from.laneIndex} → ${to.laneIndex}` : '';
      const squeezed =
        prev === onTurn &&
        computeTargets(ctx, before, prev).get(car.cellId)?.squeezePassed !== undefined;
      const slingshot = (car.slingshots ?? 0) > (prev.slingshots ?? 0);
      const how = [lane, squeezed ? 'squeeze' : '', slingshot ? 'slingshot' : ''].filter(Boolean);
      say('move', car, [`${label}${cells > 0 ? ` +${cells} cells` : ' moves'}`, ...how].join(', '));
    }

    const passed = after.cars.filter(
      (c) => c !== car && progress(was(c)!) > progress(prev) && progress(c) < progress(car)
    );
    if (passed.length > 0) {
      say(
        'pass',
        car,
        `${label} passes ${passed.map(name).join(' and ')} for P${place(after, car)}`
      );
    }

    // The rear row's first crossing (-1 to 0) only begins lap 1: silent, as everywhere (lapProgress.ts).
    const done = car.lapCount ?? 0;
    if (done > (prev.lapCount ?? 0) && done >= 1 && done < after.raceLaps) {
      const lap = lapInProgress(done, after.raceLaps);
      say(
        'lap',
        car,
        lap === after.raceLaps
          ? `${label}: final lap`
          : `${label} starts lap ${lap}/${after.raceLaps}`
      );
    }
  }

  // A car that did not move on a turn that passed, with moves not to be had, skipped (a grid setup is not a turn).
  if (onTurn && turnPassed && onTurn.state === 'ACTIVE') {
    const car = after.cars.find((c) => c.carId === onTurn.carId)!;
    if (car.cellId === onTurn.cellId) say('info', car, `${name(car)} skips (no moves)`);
  }

  // Said once: the line is the crossing of the threshold, and a pit stop (back to 100) starts it over.
  for (const car of after.cars) {
    const prev = was(car);
    if (!prev) continue;
    for (const resource of ['tire', 'fuel'] as const) {
      if (prev[resource] > 0 && car[resource] <= 0) {
        say('warn', car, `${name(car)}: out of ${resource}`);
      } else if (prev[resource] >= LOW_PERCENT && car[resource] < LOW_PERCENT) {
        say('warn', car, `${name(car)}: ${resource} ${Math.round(car[resource])}%`);
      }
    }
  }

  if (after.winnerCarId !== null && before.winnerCarId === null) {
    const winner = after.cars.find((c) => c.carId === after.winnerCarId)!;
    say('finish', winner, `${name(winner)} finishes P1`);
    const rest = after.cars.filter((c) => c !== winner).sort((a, b) => progress(b) - progress(a));
    if (rest.length > 0) {
      lines.push({
        kind: 'finish',
        text: `Result: ${rest.map((c, i) => `P${i + 2} ${name(c)}`).join(', ')}`
      });
    }
  }
  return lines;
}
