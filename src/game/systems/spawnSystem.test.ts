import { describe, expect, it } from "vitest";
import type { TrackCell, TrackData } from "../types/track";
import { buildSpawnSlots, spawnCars } from "./spawnSystem";

function makeCell(
  id: string,
  laneIndex: number,
  forwardIndex: number,
  next: string[],
  tags: TrackCell["tags"] = []
): TrackCell {
  return {
    id,
    zoneIndex: forwardIndex + 1,
    laneIndex,
    forwardIndex,
    pos: { x: forwardIndex, y: laneIndex },
    next,
    tags
  };
}

function makeTrack(): TrackData {
  const cells: TrackCell[] = [
    makeCell("A0", 1, 0, ["A1"]),
    makeCell("A1", 1, 1, ["A0"], ["START_FINISH"]),
    makeCell("B0", 2, 0, ["B1"]),
    makeCell("B1", 2, 1, ["B0"]),
    makeCell("C0", 3, 0, ["C1"]),
    makeCell("C1", 3, 1, ["C0"]),
    makeCell("P0", 0, 0, ["P1"]),
    makeCell("P1", 0, 1, ["P0"])
  ];

  return {
    trackId: "spawn-test",
    zones: 2,
    lanes: 4,
    cells
  };
}

function makeBrokenTrack(): TrackData {
  const cells: TrackCell[] = [
    makeCell("A0", 1, 0, []),
    makeCell("A1", 1, 1, [], ["START_FINISH"]),
    makeCell("B0", 2, 0, []),
    makeCell("P0", 0, 0, ["P1"], ["PIT_ENTRY"]),
    makeCell("P1", 0, 1, [], ["PIT_EXIT"])
  ];
  return {
    trackId: "spawn-broken",
    zones: 2,
    lanes: 4,
    cells
  };
}

describe("spawnSystem", () => {
  it("builds spawn slots in rows keyed to the spine lane", () => {
    const track = makeTrack();
    const slots = buildSpawnSlots(track);
    expect(slots).toHaveLength(6);
    expect(slots[0]?.forwardIndex).toBe(1);
    expect(slots[1]?.forwardIndex).toBe(1);
    expect(slots[2]?.forwardIndex).toBe(1);
    expect(slots[0]?.laneIndex).toBe(1);
    expect(slots[1]?.laneIndex).toBe(2);
    expect(slots[2]?.laneIndex).toBe(3);
  });

  it("spawns at least one car and caps to available slots", () => {
    const track = makeTrack();
    const minSpawn = spawnCars(track, { totalCars: 0, humanCount: 0, botCount: 0 });
    expect(minSpawn.cars).toHaveLength(1);

    const maxSpawn = spawnCars(track, { totalCars: 99, humanCount: 99, botCount: 0 });
    expect(maxSpawn.cars).toHaveLength(6);
  });

  it("assigns ids, tokens, and independent setups", () => {
    const track = makeTrack();
    const { cars, tokens } = spawnCars(track, { totalCars: 2, humanCount: 2, botCount: 0 });
    expect(cars[0]?.carId).toBe(1);
    expect(cars[0]?.ownerId).toBe("P1");
    expect(cars[0]?.isBot).toBe(false);
    expect(cars[1]?.carId).toBe(2);
    expect(cars[1]?.ownerId).toBe("P2");
    expect(cars[1]?.isBot).toBe(false);
    expect(tokens).toHaveLength(2);
    expect(tokens[0]?.car).toBe(cars[0]);

    const carA = cars[0]!;
    const carB = cars[1]!;
    carA.setup.psi.fl = 99;
    expect(carB.setup.psi.fl).not.toBe(99);
  });

  it("spawns all bots when humans are zero", () => {
    const track = makeTrack();
    const { cars } = spawnCars(track, { totalCars: 2, humanCount: 0, botCount: 2 });
    expect(cars).toHaveLength(2);
    expect(cars[0]?.isBot).toBe(true);
    expect(cars[1]?.isBot).toBe(true);
    expect(cars[0]?.ownerId).toBe("BOT1");
    expect(cars[1]?.ownerId).toBe("BOT2");
  });

  it("supports mixed human and bot composition", () => {
    const track = makeTrack();
    const { cars } = spawnCars(track, { totalCars: 3, humanCount: 2, botCount: 1 });
    expect(cars).toHaveLength(3);
    expect(cars[0]?.isBot).toBe(false);
    expect(cars[1]?.isBot).toBe(false);
    expect(cars[2]?.isBot).toBe(true);
  });

  it("recovers spawn rows when lane traversal is disconnected or missing", () => {
    const track = makeBrokenTrack();
    const slots = buildSpawnSlots(track);
    expect(slots.map((s) => s.id)).toEqual(["A1", "A0", "B0"]);
  });

  it("clamps explicit human and bot counts into requested total", () => {
    const track = makeTrack();
    const { cars } = spawnCars(track, { totalCars: 4, humanCount: 3, botCount: 3 });
    expect(cars).toHaveLength(4);
    expect(cars.filter((c) => !c.isBot)).toHaveLength(3);
    expect(cars.filter((c) => c.isBot)).toHaveLength(1);
  });

  it("supports explicit total derived from human and bot counts", () => {
    const track = makeTrack();
    const { cars } = spawnCars(track, { humanCount: 1, botCount: 2 });
    expect(cars).toHaveLength(3);
    expect(cars.filter((c) => !c.isBot)).toHaveLength(1);
    expect(cars.filter((c) => c.isBot)).toHaveLength(2);
  });

  it("supports legacy bot mode and bot fill options", () => {
    const track = makeTrack();
    const botMode = spawnCars(track, { playerCount: 3, botMode: true });
    expect(botMode.cars).toHaveLength(3);
    expect(botMode.cars.every((c) => c.isBot)).toBe(true);

    const botFill = spawnCars(track, { playerCount: 4, botFill: true });
    expect(botFill.cars).toHaveLength(4);
    expect(botFill.cars.filter((c) => !c.isBot)).toHaveLength(1);
    expect(botFill.cars.filter((c) => c.isBot)).toHaveLength(3);
  });
});
