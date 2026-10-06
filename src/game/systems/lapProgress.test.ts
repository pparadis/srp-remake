import { describe, expect, it } from "vitest";
import track from "../../../public/tracks/oval16_3lanes.json";
import type { Car } from "../types/car";
import type { TrackData } from "../types/track";
import { createRaceContext } from "../race/raceEngine";
import { applyMove } from "./moveCommitSystem";
import { hasFinishedRace, hasStartedLap, lapCountAtSpawn, lapInProgress } from "./lapProgress";
import { spawnCars } from "./spawnSystem";

const ctx = createRaceContext(track as unknown as TrackData);
const INFO = { distance: 1, tireCost: 0, fuelCost: 0, isPitTrigger: false };

// Moves the car one cell along its own lane, like a driver who never changes lane.
function step(car: Car) {
  const from = ctx.cellMap.get(car.cellId)!;
  const to = from.next.map((id) => ctx.cellMap.get(id)!).find((c) => c.laneIndex === from.laneIndex)!;
  applyMove(car, from, to, INFO, 1);
}

// Cells driven until the car has finished `laps` laps, and every lap count seen on the way.
function cellsToFinish(car: Car, laps: number) {
  let cells = 0;
  const seen: number[] = [car.lapCount ?? 0];
  while (!hasFinishedRace(car.lapCount, laps)) {
    step(car);
    cells += 1;
    if (seen.at(-1) !== car.lapCount) seen.push(car.lapCount ?? 0);
  }
  return { cells, seen };
}

describe("lap helpers", () => {
  it("spawn: on the line is lap 0 done, behind the line is -1", () => {
    expect(lapCountAtSpawn(0)).toBe(0);
    expect(lapCountAtSpawn(25)).toBe(-1);
    expect(lapCountAtSpawn(27)).toBe(-1);
  });

  it("lap in progress is 1-based, 0 behind the line, capped at raceLaps", () => {
    expect(hasStartedLap(-1)).toBe(false);
    expect(hasStartedLap(0)).toBe(true);
    expect(lapInProgress(-1, 5)).toBe(0);
    expect(lapInProgress(0, 5)).toBe(1);
    expect(lapInProgress(4, 5)).toBe(5);
    expect(lapInProgress(5, 5)).toBe(5);
    expect(hasFinishedRace(4, 5)).toBe(false);
    expect(hasFinishedRace(5, 5)).toBe(true);
  });
});

describe("staggered grid distance", () => {
  const cars = () => spawnCars(track as unknown as TrackData, { totalCars: 6, humanCount: 6, botCount: 0 }).cars;

  it("front row starts on the line (0), the rows behind start at -1", () => {
    const grid = cars().map((c) => [ctx.cellMap.get(c.cellId)!.forwardIndex, c.lapCount]);
    expect(grid).toEqual([[0, 0], [0, 0], [0, 0], [27, -1], [27, -1], [27, -1]]);
  });

  it("5 laps is 140 cells from the line, 141 from the row behind, 143 from fwd 25", () => {
    const [front, , , rear] = cars();
    expect(cellsToFinish(front!, 5).cells).toBe(140);
    expect(cellsToFinish(rear!, 5).cells).toBe(141);
    const deep = cars()[0]!;
    deep.cellId = [...ctx.cellMap.values()].find((c) => c.laneIndex === 1 && c.forwardIndex === 25)!.id;
    deep.lapCount = lapCountAtSpawn(25);
    expect(cellsToFinish(deep, 5).cells).toBe(143);
  });

  it("the first crossing goes -1 to 0, a plain lap start (no lap completed)", () => {
    const rear = cars()[3]!;
    const { seen } = cellsToFinish(rear, 2);
    expect(seen).toEqual([-1, 0, 1, 2]);
  });

  it("at the same pace the pole car finishes before the car behind the line in the same lane", () => {
    const grid = cars();
    const pole = grid[0]!;
    // same lane as the pole car: outer lanes have more cells per lap, so a fair race is lane for lane
    const back = grid[3]!;
    let poleDone = -1;
    let backDone = -1;
    for (let turn = 1; turn <= 200 && (poleDone < 0 || backDone < 0); turn += 1) {
      if (poleDone < 0) {
        step(pole);
        if (hasFinishedRace(pole.lapCount, 5)) poleDone = turn;
      }
      if (backDone < 0) {
        step(back);
        if (hasFinishedRace(back.lapCount, 5)) backDone = turn;
      }
    }
    expect(poleDone).toBe(140);
    expect(backDone).toBe(141);
    expect(poleDone).toBeLessThan(backDone);
  });
});
