import type { Car } from "../types/car";
import type { TrackCell, TrackData } from "../types/track";
import { createMoveCycle } from "./moveBudgetSystem";
import { MAIN_LANES, PIT_LANE } from "../constants";

interface SpawnOptions {
  totalCars?: number;
  humanCount?: number;
  botCount?: number;
  // Legacy options kept for compatibility.
  playerCount?: number;
  botMode?: boolean;
  botFill?: boolean;
}

const DEFAULT_COLORS = [0xe94cff, 0x35d0c7, 0xffc857, 0xff6b6b];
const DEFAULT_SETUPS: Car["setup"][] = [
  { compound: "soft", psi: { fl: 23, fr: 23, rl: 21, rr: 21 }, wingFrontDeg: 6, wingRearDeg: 12 },
  { compound: "hard", psi: { fl: 24, fr: 24, rl: 22, rr: 22 }, wingFrontDeg: 5, wingRearDeg: 11 },
  { compound: "soft", psi: { fl: 25, fr: 25, rl: 23, rr: 23 }, wingFrontDeg: 7, wingRearDeg: 13 },
  { compound: "hard", psi: { fl: 22, fr: 22, rl: 20, rr: 20 }, wingFrontDeg: 4, wingRearDeg: 10 }
];

export function buildSpawnSlots(track: TrackData): TrackCell[] {
  const byId = new Map<string, TrackCell>();
  for (const cell of track.cells) {
    if (cell.laneIndex === PIT_LANE) continue;
    byId.set(cell.id, cell);
  }

  const buildLaneSequence = (laneIndex: number): TrackCell[] => {
    const laneCells = track.cells.filter((c) => c.laneIndex === laneIndex);
    if (laneCells.length === 0) return [];
    const taggedStart = laneCells.find((c) => (c.tags ?? []).includes("START_FINISH"));
    let start = taggedStart ?? laneCells[0]!;
    for (const c of laneCells) {
      if (c.forwardIndex < start.forwardIndex) start = c;
    }
    const seq: TrackCell[] = [];
    const visited = new Set<string>();
    let current: TrackCell | undefined = start;
    while (current && !visited.has(current.id) && seq.length < laneCells.length) {
      visited.add(current.id);
      seq.push(current);
      const nextSameId: string | undefined = current.next.find((id) => {
        const nextCell = byId.get(id);
        return nextCell && nextCell.laneIndex === laneIndex;
      });
      current = nextSameId ? byId.get(nextSameId) : undefined;
    }
    if (seq.length < laneCells.length) {
      const remaining = laneCells
        .filter((c) => !visited.has(c.id))
        .sort((a, b) => a.forwardIndex - b.forwardIndex);
      seq.push(...remaining);
    }
    return seq;
  };

  const spineLane = 1;
  const spineSeq = buildLaneSequence(spineLane);
  const spineLen = spineSeq.length;
  const spineStartIdx = spineSeq.findIndex((c) => (c.tags ?? []).includes("START_FINISH"));
  const spineStart = spineStartIdx >= 0 ? spineStartIdx : 0;

  const lanePickByForwardIndex = new Map<number, Map<number, TrackCell>>();
  for (const lane of MAIN_LANES) {
    const seq = buildLaneSequence(lane);
    if (seq.length === 0) continue;
    const startIdx = seq.findIndex((c) => (c.tags ?? []).includes("START_FINISH"));
    const start = startIdx >= 0 ? startIdx : 0;
    const picks = new Map<number, TrackCell>();
    for (let offset = 0; offset < seq.length; offset += 1) {
      const idx = ((start - offset) % seq.length + seq.length) % seq.length;
      const cell = seq[idx];
      if (!cell) continue;
      if (!picks.has(cell.forwardIndex)) {
        picks.set(cell.forwardIndex, cell);
      }
    }
    lanePickByForwardIndex.set(lane, picks);
  }

  const slots: TrackCell[] = [];
  const rowCount = spineLen > 0 ? spineLen : 0;
  for (let row = 0; row < rowCount; row += 1) {
    const spineIdx = ((spineStart - row) % spineLen + spineLen) % spineLen;
    const spineCell = spineSeq[spineIdx];
    if (!spineCell) continue;
    const targetForwardIndex = spineCell.forwardIndex;
    for (const lane of MAIN_LANES) {
      const picks = lanePickByForwardIndex.get(lane);
      const cell = picks?.get(targetForwardIndex);
      if (cell) slots.push(cell);
    }
  }
  return slots;
}

export function spawnCars(track: TrackData, options: SpawnOptions) {
  const slots = buildSpawnSlots(track);
  const maxSlots = Math.max(1, slots.length);

  const hasExplicitComposition =
    options.totalCars != null || options.humanCount != null || options.botCount != null;

  let requestedTotal = 1;
  let humanCount = 1;
  let botCount = 0;

  if (hasExplicitComposition) {
    requestedTotal = Math.max(1, Math.min(options.totalCars ?? ((options.humanCount ?? 0) + (options.botCount ?? 0)), maxSlots));
    humanCount = Math.max(0, Math.min(options.humanCount ?? requestedTotal, requestedTotal));
    botCount = Math.max(0, Math.min(options.botCount ?? (requestedTotal - humanCount), requestedTotal - humanCount));
  } else {
    const desiredCount = Math.max(1, Math.min(options.playerCount ?? 1, maxSlots));
    const botMode = options.botMode ?? false;
    const botFill = options.botFill ?? false;
    requestedTotal = desiredCount;
    if (botMode) {
      humanCount = 0;
      botCount = desiredCount;
    } else if (botFill) {
      humanCount = 1;
      botCount = Math.max(0, desiredCount - 1);
    } else {
      humanCount = desiredCount;
      botCount = 0;
    }
  }

  const count = Math.max(1, Math.min(requestedTotal, humanCount + botCount, maxSlots));
  // `humanCount` is already clamped to `requestedTotal`, and `count` is
  // constrained by `humanCount + botCount`, so only bot count may need trimming.
  botCount = Math.min(botCount, count - humanCount);

  const orderedSlots = slots;

  const cars: Car[] = [];
  const tokens: Array<{ car: Car; color: number }> = [];

  for (let i = 0; i < count; i += 1) {
    const cell = orderedSlots[i];
    if (!cell) continue;
    const setup = (DEFAULT_SETUPS[i % DEFAULT_SETUPS.length] ?? DEFAULT_SETUPS[0])!;
    const isBot = i >= humanCount;
    const botIndex = i - humanCount + 1;
    const car: Car = {
      carId: i + 1,
      ownerId: isBot ? `BOT${botIndex}` : `P${i + 1}`,
      isBot,
      cellId: cell.id,
      lapCount: 0,
      tire: 100,
      fuel: 100,
      setup: structuredClone(setup),
      state: "ACTIVE",
      pitTurnsRemaining: 0,
      pitExitBoost: false,
      pitServiced: false,
      moveCycle: createMoveCycle()
    };
    cars.push(car);
    const color = (DEFAULT_COLORS[i % DEFAULT_COLORS.length] ?? DEFAULT_COLORS[0])!;
    tokens.push({ car, color });
  }

  return { cars, tokens };
}
