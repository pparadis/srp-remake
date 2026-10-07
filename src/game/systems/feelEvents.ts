// Turns successive race snapshots into the moments worth a toast or a sound. Phaser-free.
import { resourceLevel } from "../../ui/hud";

export type FeelEvent =
  | { type: "move" }
  | { type: "lap"; lap: number; laps: number; final: boolean }
  | { type: "low"; resource: "tire" | "fuel" }
  | { type: "turn" }
  | { type: "finish" };

export interface FeelView {
  /** The local player's car; lap, low-resource and turn events are only for it. */
  myCarId: number | null;
  raceLaps: number;
  finished: boolean;
  canControl: boolean;
  cars: Array<{ carId: number; lapCount: number; cellId: string; tire: number; fuel: number }>;
}

interface FeelMemory {
  seeded: boolean;
  cells: Map<number, string>;
  laps: number;
  // 0 fine, 1 below 20%, 2 empty
  low: { tire: number; fuel: number };
  canControl: boolean;
  finished: boolean;
}

export const createFeelMemory = (): FeelMemory => ({
  seeded: false,
  cells: new Map(),
  laps: 0,
  low: { tire: 0, fuel: 0 },
  canControl: false,
  finished: false
});

const lowLevel = (percent: number) => (percent <= 0 ? 2 : resourceLevel(percent) === "crit" ? 1 : 0);

/**
 * Compares the view with the last one. The first view only seeds the memory, so joining or
 * reloading mid-race never fires a toast or a sound.
 */
export function detectFeel(mem: FeelMemory, view: FeelView): FeelEvent[] {
  const events: FeelEvent[] = [];
  const mine = view.cars.find((car) => car.carId === view.myCarId);
  const low = { tire: lowLevel(mine?.tire ?? 100), fuel: lowLevel(mine?.fuel ?? 100) };
  const laps = mine?.lapCount ?? 0;

  if (mem.seeded) {
    if (view.cars.some((car) => mem.cells.get(car.carId) !== car.cellId)) events.push({ type: "move" });
    // Crossing the line starts lap laps+1. The first crossing of a car that began behind the line
    // (-1 to 0) is silent, and so is the one that ends the race (the finish event covers it).
    if (mine && laps > mem.laps && laps >= 1 && !view.finished) {
      events.push({ type: "lap", lap: laps + 1, laps: view.raceLaps, final: laps + 1 === view.raceLaps });
    }
    for (const resource of ["tire", "fuel"] as const) {
      if (low[resource] > mem.low[resource]) events.push({ type: "low", resource });
    }
    if (view.canControl && !mem.canControl) events.push({ type: "turn" });
    if (view.finished && !mem.finished) events.push({ type: "finish" });
  }

  mem.seeded = true;
  mem.cells = new Map(view.cars.map((car) => [car.carId, car.cellId]));
  mem.laps = laps;
  mem.low = low;
  mem.canControl = view.canControl;
  mem.finished = view.finished;
  return events;
}
