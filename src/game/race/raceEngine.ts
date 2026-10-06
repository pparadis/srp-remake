// Phaser-free race engine: the one place the turn rules live.
// Single-player (RaceScene) and the multiplayer server both drive a race through
// `applyAction`, so the rules can't drift between them.
import { MOVE_BUDGET, MOVE_RATES, SETUP_LIMITS } from "../constants";
import type { BotLevel, Car, CarSetup } from "../types/car";
import type { TrackCell, TrackData } from "../types/track";
import { buildPlanContext, IDEAL_PIT_SETUP } from "../systems/botPlan";
import { decideBotActionWithTrace, type BotDecisionTrace, type BotPolicy } from "../systems/botSystem";
import { decideHardBotAction } from "./botHard";
import { applyMove } from "../systems/moveCommitSystem";
import { getRemainingBudget, recordMove } from "../systems/moveBudgetSystem";
import { validateMoveAttempt } from "../systems/moveValidationSystem";
import { computeValidTargets, type TargetInfo } from "../systems/movementSystem";
import { advancePitPenalty, applyPitStop } from "../systems/pitSystem";
import { spawnCars } from "../systems/spawnSystem";
import { buildTrackIndex, type TrackIndex } from "../systems/trackIndex";
import { advanceTurn, createTurnState, getCurrentCarId, type TurnState } from "../systems/turnSystem";

export interface RaceContext {
  track: TrackData;
  trackIndex: TrackIndex;
  cellMap: Map<string, TrackCell>;
}

export interface RaceSeat {
  isBot: boolean;
  ownerId: string;
  // Difficulty of a bot seat; "normal" when omitted. Ignored for humans.
  botLevel?: BotLevel;
}

export interface RaceState {
  cars: Car[];
  turn: TurnState;
  raceLaps: number;
  winnerCarId: number | null;
}

export type RaceAction =
  | { type: "move"; targetCellId: string }
  | { type: "pit"; targetCellId: string; setup: CarSetup }
  | { type: "skip" };

export type RejectReason =
  | "race_finished"
  | "invalid_target"
  | "inactive_car"
  | "not_pit_box"
  | "use_pit_action"
  | "invalid_setup"
  | "moves_available";

export type ApplyResult =
  | { ok: true; carId: number; fromCellId: string; moveSpend: number; log: string[] }
  | { ok: false; reason: RejectReason };

export interface BotTurnDecision {
  action: RaceAction;
  // Null when the car was inactive and no targets were evaluated.
  trace: BotDecisionTrace | null;
  targets: Map<string, TargetInfo>;
  // Why the bot skipped, for debug logs.
  skipNote?: "inactive" | "no-target";
}

export function createRaceContext(track: TrackData): RaceContext {
  const trackIndex = buildTrackIndex(track);
  return { track, trackIndex, cellMap: trackIndex.cellMap };
}

export function createRace(ctx: RaceContext, seats: RaceSeat[], raceLaps: number): RaceState {
  const { cars } = spawnCars(ctx.track, {
    totalCars: seats.length,
    humanCount: seats.length,
    botCount: 0
  });
  if (cars.length !== seats.length) {
    throw new Error(`Track has room for ${cars.length} cars, ${seats.length} requested.`);
  }
  cars.forEach((car, i) => {
    const seat = seats[i]!;
    car.isBot = seat.isBot;
    car.ownerId = seat.ownerId;
    if (seat.isBot) car.botLevel = seat.botLevel ?? "normal";
  });
  return { cars, turn: createTurnState(cars), raceLaps, winnerCarId: null };
}

export function getActiveCar(state: RaceState): Car {
  const currentId = getCurrentCarId(state.turn);
  const car = state.cars.find((c) => c.carId === currentId) ?? state.cars[0];
  if (!car) throw new Error("No cars available.");
  return car;
}

export function computeTargets(ctx: RaceContext, state: RaceState, car: Car): Map<string, TargetInfo> {
  const occupied = new Set(state.cars.map((c) => c.cellId));
  const baseMaxSteps =
    car.tire === 0 || car.fuel === 0 ? MOVE_BUDGET.zeroResourceMax : MOVE_BUDGET.baseMax;
  const maxSteps = Math.min(baseMaxSteps, Math.max(0, getRemainingBudget(car.moveCycle)));
  const tireRate = car.setup.compound === "soft" ? MOVE_RATES.softTire : MOVE_RATES.hardTire;
  return computeValidTargets(
    ctx.trackIndex,
    car.cellId,
    occupied,
    maxSteps,
    { allowPitExitSkip: car.pitExitBoost, disallowPitBoxTargets: car.pitServiced },
    { tireRate, fuelRate: MOVE_RATES.fuel, setup: car.setup }
  );
}

export function isValidSetup(setup: CarSetup): boolean {
  const { psi, wingDeg } = SETUP_LIMITS;
  const psiOk = [setup.psi.fl, setup.psi.fr, setup.psi.rl, setup.psi.rr].every(
    (v) => Number.isInteger(v) && v >= psi.min && v <= psi.max
  );
  const wingOk = [setup.wingFrontDeg, setup.wingRearDeg].every(
    (v) => Number.isInteger(v) && v >= wingDeg.min && v <= wingDeg.max
  );
  return (setup.compound === "soft" || setup.compound === "hard") && psiOk && wingOk;
}

function findWinner(state: RaceState): Car | null {
  const active = getActiveCar(state);
  if ((active.lapCount ?? 0) >= state.raceLaps) return active;
  return state.cars.find((car) => (car.lapCount ?? 0) >= state.raceLaps) ?? null;
}

// Cars serving a pit penalty lose their turn; stop at the first car that can play.
function selectNextPlayable(state: RaceState, log: string[]) {
  const maxSkips = Math.max(1, state.cars.length);
  for (let i = 0; i < maxSkips; i += 1) {
    const car = getActiveCar(state);
    if (advancePitPenalty(car)) {
      recordMove(car.moveCycle, 0);
      log.push(`Car ${car.carId} pit penalty (remaining ${car.pitTurnsRemaining}).`);
      advanceTurn(state.turn);
      continue;
    }
    break;
  }
  log.push(`Car ${getActiveCar(state).carId} to play.`);
}

// Validates and applies one action for the active car. On rejection the state is untouched.
export function applyAction(ctx: RaceContext, state: RaceState, action: RaceAction): ApplyResult {
  if (state.winnerCarId !== null) return { ok: false, reason: "race_finished" };

  const car = getActiveCar(state);
  const fromCell = ctx.cellMap.get(car.cellId) ?? null;
  const fromCellId = car.cellId;
  const log: string[] = [];
  let moveSpend = 0;

  if (action.type === "skip") {
    if (car.state === "ACTIVE" && computeTargets(ctx, state, car).size > 0) {
      return { ok: false, reason: "moves_available" };
    }
    recordMove(car.moveCycle, 0);
    log.push(`Car ${car.carId} skipped (no moves).`);
  } else {
    const targetCell = ctx.cellMap.get(action.targetCellId) ?? null;
    const check = validateMoveAttempt(car, fromCell, targetCell, computeTargets(ctx, state, car), true);
    if (!check.ok || !check.info || !targetCell || !fromCell || check.moveSpend == null) {
      return { ok: false, reason: check.reason === "inactive-car" ? "inactive_car" : "invalid_target" };
    }
    if (action.type === "move") {
      if (check.isPitStop) return { ok: false, reason: "use_pit_action" };
      applyMove(car, fromCell, targetCell, check.info, check.moveSpend);
      moveSpend = check.moveSpend;
      log.push(`Car ${car.carId} moved to ${targetCell.id}.`);
    } else {
      if (!check.isPitStop) return { ok: false, reason: "not_pit_box" };
      if (!isValidSetup(action.setup)) return { ok: false, reason: "invalid_setup" };
      applyPitStop(car, targetCell.id, structuredClone(action.setup));
      recordMove(car.moveCycle, check.moveSpend);
      moveSpend = check.moveSpend;
      log.push(`Car ${car.carId} pit stop at ${targetCell.id}.`);
    }
  }

  const winner = findWinner(state);
  if (winner) {
    state.winnerCarId = winner.carId;
    log.push(`Race finished. Car ${winner.carId} wins (${winner.lapCount ?? 0}/${state.raceLaps} laps).`);
    return { ok: true, carId: car.carId, fromCellId, moveSpend, log };
  }

  advanceTurn(state.turn);
  selectNextPlayable(state, log);
  return { ok: true, carId: car.carId, fromCellId, moveSpend, log };
}

// Picks the active car's action with a bot policy: by default the car's own botLevel ("normal"
// when it has none); the server passes "autopilot" to play an AFK human's turn. Does not mutate state.
export function decideBotAction(
  ctx: RaceContext,
  state: RaceState,
  policy?: BotPolicy
): BotTurnDecision {
  const car = getActiveCar(state);
  if (car.state !== "ACTIVE") {
    return { action: { type: "skip" }, trace: null, targets: new Map(), skipNote: "inactive" };
  }
  const level: BotPolicy = policy ?? car.botLevel ?? "normal";
  const targets = computeTargets(ctx, state, car);
  const plan = buildPlanContext(ctx.trackIndex, state.raceLaps);
  const { action, trace } = decideBotActionWithTrace(targets, car, ctx.cellMap, level, plan);
  let decision: BotTurnDecision;
  if (action.type === "skip") {
    return { action: { type: "skip" }, trace, targets, skipNote: "no-target" };
  }
  if (action.type === "pit") {
    // Easy keeps whatever setup it has; Normal and Hard service with the cheapest-to-run one.
    const setup = level === "easy" ? car.setup : IDEAL_PIT_SETUP;
    decision = { action: { type: "pit", targetCellId: action.target.id, setup: structuredClone(setup) }, trace, targets };
  } else {
    decision = { action: { type: "move", targetCellId: action.target.id }, trace, targets };
  }
  if (level !== "hard") return decision;
  return decideHardBotAction(ctx, state, car, decision, {
    applyAction,
    computeTargets,
    decideNormal: (c, s) => decideBotAction(c, s, "normal")
  });
}
