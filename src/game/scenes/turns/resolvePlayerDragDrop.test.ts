import type Phaser from "phaser";
import { describe, expect, it, vi } from "vitest";
import type { Car } from "../../types/car";
import type { TrackCell } from "../../types/track";
import type { MoveValidationResult } from "../../systems/moveValidationSystem";
import { PIT_LANE } from "../../constants";
import { resolvePlayerDragDrop } from "./resolvePlayerDragDrop";

function makeCell(id: string, laneIndex: number, x: number, y: number): TrackCell {
  return {
    id,
    zoneIndex: 1,
    laneIndex,
    forwardIndex: 0,
    pos: { x, y },
    next: [],
    tags: []
  };
}

function makeCar(overrides: Partial<Car> = {}): Car {
  return {
    carId: 1,
    ownerId: "P1",
    isBot: false,
    cellId: "A",
    lapCount: 0,
    tire: 90,
    fuel: 90,
    setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    },
    state: "ACTIVE",
    pitTurnsRemaining: 0,
    pitExitBoost: true,
    pitServiced: true,
    moveCycle: { index: 0, spent: [0, 0, 0, 0, 0] },
    ...overrides
  };
}

function makeToken(x: number, y: number): Phaser.GameObjects.Container {
  return {
    x,
    y,
    setPosition(nextX: number, nextY: number) {
      this.x = nextX;
      this.y = nextY;
      return this;
    }
  } as Phaser.GameObjects.Container;
}

function makeHalo(x: number, y: number): Phaser.GameObjects.Ellipse {
  return {
    x,
    y,
    setPosition(nextX: number, nextY: number) {
      this.x = nextX;
      this.y = nextY;
      return this;
    }
  } as Phaser.GameObjects.Ellipse;
}

function makeOkValidation(moveSpend: number, isPitStop = false): MoveValidationResult {
  return {
    ok: true,
    info: { distance: moveSpend, moveSpend, tireCost: 1, fuelCost: 1, isPitTrigger: false },
    moveSpend,
    isPitStop
  };
}

describe("resolvePlayerDragDrop", () => {
  it("hands a normal move to the engine without touching the car", () => {
    const car = makeCar({ cellId: "A", pitExitBoost: true, pitServiced: true });
    const fromCell = makeCell("A", 1, 10, 20);
    const toCell = makeCell("B", 2, 100, 200);
    const token = makeToken(15, 25);
    const onOpenPitModal = vi.fn();
    const onMove = vi.fn();

    resolvePlayerDragDrop({
      activeCar: car,
      token,
      origin: { x: 15, y: 25 },
      nearestCell: toCell,
      validation: makeOkValidation(3),
      cellMap: new Map([
        ["A", fromCell],
        ["B", toCell]
      ]),
      activeHalo: makeHalo(15, 25),
      onOpenPitModal,
      onMove
    });

    expect(onMove).toHaveBeenCalledWith("B");
    expect(onOpenPitModal).not.toHaveBeenCalled();
    expect(token.x).toBe(100);
    expect(token.y).toBe(200);
    expect(car).toMatchObject({ cellId: "A", pitExitBoost: true, pitServiced: true });
  });

  it("opens the pit modal for a pit stop instead of moving", () => {
    const car = makeCar({ cellId: "A", pitServiced: false });
    const pitCell = makeCell("P1", PIT_LANE, 30, 40);
    const token = makeToken(10, 20);
    const onOpenPitModal = vi.fn();
    const onMove = vi.fn();

    resolvePlayerDragDrop({
      activeCar: car,
      token,
      origin: { x: 10, y: 20 },
      nearestCell: pitCell,
      validation: makeOkValidation(1, true),
      cellMap: new Map([
        ["A", makeCell("A", 1, 10, 20)],
        ["P1", pitCell]
      ]),
      activeHalo: null,
      onOpenPitModal,
      onMove
    });

    expect(onOpenPitModal).toHaveBeenCalledWith(pitCell, { x: 10, y: 20 });
    expect(onMove).not.toHaveBeenCalled();
    expect(car.cellId).toBe("A");
    expect(token.x).toBe(30);
    expect(token.y).toBe(40);
  });

  it("resets token and halo to current active cell when validation fails", () => {
    const car = makeCar({ cellId: "A" });
    const currentCell = makeCell("A", 1, 11, 22);
    const token = makeToken(99, 99);
    const halo = makeHalo(99, 99);
    const onMove = vi.fn();

    resolvePlayerDragDrop({
      activeCar: car,
      token,
      origin: { x: 5, y: 6 },
      nearestCell: null,
      validation: { ok: false, reason: "invalid-target" },
      cellMap: new Map([["A", currentCell]]),
      activeHalo: halo,
      onOpenPitModal: vi.fn(),
      onMove
    });

    expect(onMove).not.toHaveBeenCalled();
    expect(token.x).toBe(11);
    expect(token.y).toBe(22);
    expect(halo.x).toBe(11);
    expect(halo.y).toBe(22);
  });

  it("resets token and halo to drag origin when active cell is missing", () => {
    const car = makeCar({ cellId: "MISSING" });
    const token = makeToken(50, 60);
    const halo = makeHalo(50, 60);

    resolvePlayerDragDrop({
      activeCar: car,
      token,
      origin: { x: 7, y: 8 },
      nearestCell: null,
      validation: { ok: false, reason: "no-cell" },
      cellMap: new Map(),
      activeHalo: halo,
      onOpenPitModal: vi.fn(),
      onMove: vi.fn()
    });

    expect(token.x).toBe(7);
    expect(token.y).toBe(8);
    expect(halo.x).toBe(7);
    expect(halo.y).toBe(8);
  });
});
