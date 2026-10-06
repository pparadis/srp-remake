import { describe, expect, it } from "vitest";
import { createFeelMemory, detectFeel, type FeelView } from "./feelEvents";

const view = (over: Partial<FeelView> = {}, mine: Partial<FeelView["cars"][number]> = {}): FeelView => ({
  myCarId: 1,
  raceLaps: 3,
  finished: false,
  canControl: false,
  cars: [
    { carId: 1, lapCount: 0, cellId: "a", tire: 90, fuel: 90, ...mine },
    { carId: 2, lapCount: 0, cellId: "b", tire: 90, fuel: 90 }
  ],
  ...over
});

describe("detectFeel", () => {
  it("fires nothing on the first view, even mid-race and mid-lap", () => {
    const mem = createFeelMemory();
    expect(detectFeel(mem, view({ canControl: true }, { lapCount: 2, tire: 5 }))).toEqual([]);
    expect(detectFeel(mem, view({ canControl: true }, { lapCount: 2, tire: 5 }))).toEqual([]);
  });

  it("reports a move when any car changes cell", () => {
    const mem = createFeelMemory();
    detectFeel(mem, view());
    expect(detectFeel(mem, view({}, { cellId: "c" }))).toEqual([{ type: "move" }]);
  });

  it("reports my laps, flags the last lap, and ignores other cars' laps", () => {
    const mem = createFeelMemory();
    detectFeel(mem, view());
    const other = view();
    other.cars[1]!.lapCount = 1;
    expect(detectFeel(mem, other)).toEqual([]);
    // lapCount 1 = lap 1 completed = lap 2 just started
    expect(detectFeel(mem, view({}, { lapCount: 1 }))).toEqual([{ type: "lap", lap: 2, laps: 3, final: false }]);
    expect(detectFeel(mem, view({}, { lapCount: 2 }))).toEqual([{ type: "lap", lap: 3, laps: 3, final: true }]);
  });

  it("the first crossing of a car that started behind the line (-1 to 0) is silent", () => {
    const mem = createFeelMemory();
    detectFeel(mem, view({}, { lapCount: -1 }));
    expect(detectFeel(mem, view({}, { lapCount: 0 }))).toEqual([]);
    // the next crossing is a normal one
    expect(detectFeel(mem, view({}, { lapCount: 1 }))).toEqual([{ type: "lap", lap: 2, laps: 3, final: false }]);
  });

  it("finishing is a finish, not a lap", () => {
    const mem = createFeelMemory();
    detectFeel(mem, view({}, { lapCount: 2 }));
    expect(detectFeel(mem, view({ finished: true }, { lapCount: 3 }))).toEqual([{ type: "finish" }]);
    expect(detectFeel(mem, view({ finished: true }, { lapCount: 3 }))).toEqual([]);
  });

  it("beeps once per drop below 20% and again when empty", () => {
    const mem = createFeelMemory();
    detectFeel(mem, view());
    expect(detectFeel(mem, view({}, { fuel: 15 }))).toEqual([{ type: "low", resource: "fuel" }]);
    expect(detectFeel(mem, view({}, { fuel: 10 }))).toEqual([]);
    expect(detectFeel(mem, view({}, { fuel: 0 }))).toEqual([{ type: "low", resource: "fuel" }]);
    // a pit stop refills; running low again beeps again
    detectFeel(mem, view({}, { fuel: 100 }));
    expect(detectFeel(mem, view({}, { fuel: 19 }))).toEqual([{ type: "low", resource: "fuel" }]);
  });

  it("pings when the turn becomes mine, not while it stays mine", () => {
    const mem = createFeelMemory();
    detectFeel(mem, view());
    expect(detectFeel(mem, view({ canControl: true }))).toEqual([{ type: "turn" }]);
    expect(detectFeel(mem, view({ canControl: true }))).toEqual([]);
  });

  it("without a local car only moves and the finish are reported", () => {
    const mem = createFeelMemory();
    detectFeel(mem, view({ myCarId: null }));
    expect(detectFeel(mem, view({ myCarId: null, finished: true }, { cellId: "z", lapCount: 3 }))).toEqual([
      { type: "move" },
      { type: "finish" }
    ]);
  });
});
