// Phaser-free race engine: the one place the turn rules live.
// Single-player (RaceScene) and the multiplayer server both drive a race through
// `applyAction`, so the rules can't drift between them.
import { DRAFT_SLINGSHOT_TURNS, PIT_LANE } from '../constants';
import { must } from '../must';
import { hasFinishedRace } from '../systems/lap_progress';
import type { BotLevel, Car, CarSetup } from '../types/car';
import type { TrackCell, TrackData } from '../types/track';
import { bestSetup, buildPlanContext, pitSetupFor, type BotPlanContext } from '../systems/bot_plan';
import {
  turnOrderOf,
  personalityFor,
  personalityOf,
  PERSONALITIES,
  type PersonalityKey
} from '../systems/bot_style';
import { trackFwd } from '../systems/track_index';
import {
  decideBotActionWithTrace,
  type BotDecisionTrace,
  type BotPolicy
} from '../systems/bot_system';
import { decideHardBotAction } from './bot_hard';
import { applyMove, crossesStartLine } from '../systems/move_commit_system';
import { getRemainingBudget, recordMove } from '../systems/move_budget_system';
import { validateMoveAttempt } from '../systems/move_validation_system';
import type { TargetInfo } from '../systems/movement_system';
import { DEFAULT_RULES_VERSION, resourcesOf, rulesOf, type RulesVersion } from '../rules/versions';
import { advancePitPenalty, applyPitStop } from '../systems/pit_system';
import { spawnCars } from '../systems/spawn_system';
import { buildTrackIndex, type TrackIndex } from '../systems/track_index';
import { advanceTurn, getCurrentCarId, type TurnState } from '../systems/turn_system';

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
  // Bench/test override of the seed-derived personality.
  style?: PersonalityKey | undefined;
}

export interface RaceState {
  cars: Car[];
  turn: TurnState;
  raceLaps: number;
  winnerCarId: number | null;
  // Per-race integer that decides every bot's personality (and Easy's dice); 0 = the neutral baseline.
  // Created at the boundary (server at race start, solo scene), never inside the engine.
  seed: number;
  // The movement rules this race plays on (src/game/rules/versions.ts), set by createRace and never changed (#118).
  // Absent in a state made before versions existed: it plays the default.
  rulesVersion?: RulesVersion;
}

export type RaceAction =
  | { type: 'move'; targetCellId: string }
  | { type: 'pit'; targetCellId: string; setup: CarSetup }
  // Grid setup: compound, pressures and wing, free, before the car's first turn is played. Does not end the turn.
  | { type: 'setup'; setup: CarSetup }
  | { type: 'skip' };

export type RejectReason =
  | 'race_finished'
  | 'invalid_target'
  | 'inactive_car'
  | 'not_pit_box'
  | 'use_pit_action'
  | 'invalid_setup'
  | 'setup_locked'
  | 'moves_available';

export type ApplyResult =
  | { ok: true; carId: number; fromCellId: string; moveSpend: number }
  | { ok: false; reason: RejectReason };

export interface BotTurnDecision {
  action: RaceAction;
  // Null when the car was inactive and no targets were evaluated.
  trace: BotDecisionTrace | null;
  targets: Map<string, TargetInfo>;
  // Why the bot skipped, for debug logs.
  skipNote?: 'inactive' | 'no-target';
}

export function createRaceContext(track: TrackData): RaceContext {
  const trackIndex = buildTrackIndex(track);
  return { track, trackIndex, cellMap: trackIndex.cellMap };
}

export function createRace(
  ctx: RaceContext,
  seats: RaceSeat[],
  raceLaps: number,
  seed = 0,
  rulesVersion: RulesVersion = DEFAULT_RULES_VERSION
): RaceState {
  const { cars } = spawnCars(
    ctx.track,
    {
      totalCars: seats.length,
      humanCount: seats.length,
      botCount: 0
    },
    seed
  );
  if (cars.length !== seats.length) {
    throw new Error(`Track has room for ${cars.length} cars, ${seats.length} requested.`);
  }
  cars.forEach((car, i) => {
    const seat = must(seats[i], 'seat');
    car.isBot = seat.isBot;
    car.ownerId = seat.ownerId;
    if (seat.isBot) car.botLevel = seat.botLevel ?? 'normal';
    if (seat.isBot && seat.style) car.style = seat.style;
  });
  // Everyone is dealt the version's default setup; bots then set up for the distance they must cover (Easy keeps the
  // default it is dealt).
  const resources = resourcesOf({ rulesVersion, raceLaps }, ctx.trackIndex);
  const plan = buildPlanContext(ctx.trackIndex, raceLaps, resources);
  for (const car of cars) {
    resources.gridSetup(car, resources.defaultSetup(car.setup));
    if (!car.isBot || car.botLevel === 'easy') continue;
    resources.gridSetup(car, bestSetup(raceLaps * plan.spineLen, resources));
  }
  return {
    cars,
    turn: { order: turnOrderOf(seed, cars.length), index: 0 },
    raceLaps,
    winnerCarId: null,
    seed,
    rulesVersion
  };
}

// Seat (carId - 1) of the car to play; the play order is the grid order, not the car order.
export function activeSeatIndex(state: RaceState): number {
  return getActiveCar(state).carId - 1;
}

export function getActiveCar(state: RaceState): Car {
  const currentId = getCurrentCarId(state.turn);
  const car = state.cars.find((c) => c.carId === currentId) ?? state.cars[0];
  if (!car) throw new Error('No cars available.');
  return car;
}

export function computeTargets(
  ctx: RaceContext,
  state: RaceState,
  car: Car
): Map<string, TargetInfo> {
  const occupied = new Set(state.cars.map((c) => c.cellId));
  const rules = rulesOf(state);
  const resources = resourcesOf(state, ctx.trackIndex);
  const maxSteps = Math.min(
    resources.moveCap(car),
    Math.max(0, getRemainingBudget(car.moveCycle, resources.cycleBudget(car)))
  );
  const costs = resources.wearRates(car.setup);
  const normal = rules.computeValidTargets(
    ctx.trackIndex,
    car.cellId,
    occupied,
    maxSteps,
    {
      allowPitExitSkip: car.pitExitBoost,
      disallowPitBoxTargets: car.pitServiced,
      // `draftTurns` counts the moves in a row that ENDED tucked in behind a car (set in applyAction): the car that
      // did so is in its tow for this move, whatever the leader has done since.
      drafted: (car.draftTurns ?? 0) >= 1,
      slingshotReady: (car.draftTurns ?? 0) >= DRAFT_SLINGSHOT_TURNS
    },
    costs
  );
  if (car.state !== 'ACTIVE') return normal;
  // A pit entry alone does not count as a way out: the squeeze is offered next to it (#137).
  const inPit = ctx.cellMap.get(car.cellId)?.laneIndex === PIT_LANE;
  const wayOut = inPit
    ? normal.size > 0
    : [...normal.keys()].some((id) => ctx.cellMap.get(id)?.laneIndex !== PIT_LANE);
  if (wayOut) return normal;
  const squeeze = rules.computeSqueezeTargets(
    ctx.trackIndex,
    car.cellId,
    occupied,
    maxSteps,
    costs
  );
  return new Map([...normal, ...squeeze]);
}

// True when the car stands tucked in right now: another car 1 to DRAFT_RANGE cells ahead in its own lane. The rule
// reads it at the end of a move (applyAction): at the start of a turn every car has moved away from where it was.
export function isDrafting(ctx: RaceContext, state: RaceState, car: Car): boolean {
  return (
    rulesOf(state).draftAhead(
      ctx.trackIndex,
      car.cellId,
      state.cars.map((c) => c.cellId)
    ) !== null
  );
}

function findWinner(state: RaceState): Car | null {
  const active = getActiveCar(state);
  if (hasFinishedRace(active.lapCount, state.raceLaps)) return active;
  return state.cars.find((car) => hasFinishedRace(car.lapCount, state.raceLaps)) ?? null;
}

// Cars serving a pit penalty lose their turn; stop at the first car that can play.
function selectNextPlayable(state: RaceState) {
  const maxSkips = Math.max(1, state.cars.length);
  for (let i = 0; i < maxSkips; i += 1) {
    const car = getActiveCar(state);
    if (advancePitPenalty(car)) {
      recordMove(car.moveCycle, 0);
      advanceTurn(state.turn);
      continue;
    }
    break;
  }
}

// Validates and applies one action for the active car. On rejection the state is untouched.
export function applyAction(ctx: RaceContext, state: RaceState, action: RaceAction): ApplyResult {
  if (state.winnerCarId !== null) return { ok: false, reason: 'race_finished' };

  const car = getActiveCar(state);
  const resources = resourcesOf(state, ctx.trackIndex);
  const fromCell = ctx.cellMap.get(car.cellId) ?? null;
  const fromCellId = car.cellId;
  let moveSpend = 0;

  if (action.type === 'setup') {
    if (car.setupLocked) return { ok: false, reason: 'setup_locked' };
    if (!resources.isValidSetup(action.setup)) return { ok: false, reason: 'invalid_setup' };
    resources.gridSetup(car, action.setup);
    // Not a turn: the same car still plays, and the race cannot end on it.
    return { ok: true, carId: car.carId, fromCellId, moveSpend: 0 };
  }

  if (action.type === 'skip') {
    if (car.state === 'ACTIVE' && computeTargets(ctx, state, car).size > 0) {
      return { ok: false, reason: 'moves_available' };
    }
    car.setupLocked = true;
    recordMove(car.moveCycle, 0);
  } else {
    const targetCell = ctx.cellMap.get(action.targetCellId) ?? null;
    const check = validateMoveAttempt(
      car,
      fromCell,
      targetCell,
      computeTargets(ctx, state, car),
      true
    );
    if (!check.ok || !check.info || !targetCell || !fromCell || check.moveSpend == null) {
      return {
        ok: false,
        reason: check.reason === 'inactive-car' ? 'inactive_car' : 'invalid_target'
      };
    }
    if (action.type === 'move') {
      if (check.isPitStop) return { ok: false, reason: 'use_pit_action' };
      applyMove(car, fromCell, targetCell, check.info, check.moveSpend, ctx.trackIndex.pitLineFwd);
      car.setupLocked = true;
      moveSpend = check.moveSpend;
      if (check.info.slingshot) car.slingshots = (car.slingshots ?? 0) + 1;
    } else {
      if (!check.isPitStop) return { ok: false, reason: 'not_pit_box' };
      if (!resources.isValidSetup(action.setup)) return { ok: false, reason: 'invalid_setup' };
      // A jump from the entry to a box can pass the pit line cell: that is a lap crossing too.
      if (crossesStartLine(fromCell, targetCell, ctx.trackIndex.pitLineFwd)) {
        car.lapCount = (car.lapCount ?? 0) + 1;
      }
      applyPitStop(car, targetCell.id, structuredClone(action.setup), resources);
      car.setupLocked = true;
      recordMove(car.moveCycle, check.moveSpend);
      moveSpend = check.moveSpend;
    }
  }

  // A setup returned above (it is not a turn). Here the turn was played: a move that ends tucked in behind a car adds
  // to the run (it carries to the car's next move); a move that ends elsewhere, a skip or a pit stop breaks it.
  car.draftTurns =
    action.type === 'move' && isDrafting(ctx, state, car) ? (car.draftTurns ?? 0) + 1 : 0;

  const winner = findWinner(state);
  if (winner) {
    state.winnerCarId = winner.carId;
    return { ok: true, carId: car.carId, fromCellId, moveSpend };
  }

  advanceTurn(state.turn);
  selectNextPlayable(state);
  return { ok: true, carId: car.carId, fromCellId, moveSpend };
}

// Picks the active car's action with a bot policy: by default the car's own botLevel ("normal"
// when it has none); the server passes "autopilot" to play an AFK human's turn. Does not mutate state.
export function decideBotAction(
  ctx: RaceContext,
  state: RaceState,
  policy?: BotPolicy
): BotTurnDecision {
  const car = getActiveCar(state);
  if (car.state !== 'ACTIVE') {
    return { action: { type: 'skip' }, trace: null, targets: new Map(), skipNote: 'inactive' };
  }
  const level: BotPolicy = policy ?? car.botLevel ?? 'normal';
  const targets = computeTargets(ctx, state, car);
  const plan: BotPlanContext = {
    ...buildPlanContext(ctx.trackIndex, state.raceLaps, resourcesOf(state, ctx.trackIndex)),
    // Humans (and the autopilot standing in for one) have no style; bots draw theirs from the race seed.
    style:
      level === 'hard'
        ? PERSONALITIES.adaptive
        : !car.isBot
          ? PERSONALITIES.balanced
          : car.style
            ? personalityFor(car.style as PersonalityKey, state.seed, car.carId)
            : personalityOf(state.seed, car.carId),
    adapt: level === 'hard',
    seed: state.seed,
    rivals: state.cars
      .filter((c) => c.carId !== car.carId)
      .map((c) => {
        const cell = must(ctx.cellMap.get(c.cellId), 'cell of a rival');
        return { fwd: trackFwd(cell, ctx.trackIndex.lane1FwdByZone), lane: cell.laneIndex };
      })
  };
  const { action, trace } = decideBotActionWithTrace(
    targets,
    car,
    ctx.cellMap,
    plan.resources,
    level,
    plan
  );
  let decision: BotTurnDecision;
  if (action.type === 'skip') {
    return { action: { type: 'skip' }, trace, targets, skipNote: 'no-target' };
  }
  if (action.type === 'pit') {
    // Easy keeps whatever setup it has; Normal and Hard service with the cheapest-to-run one.
    const setup = level === 'easy' ? car.setup : pitSetupFor(car, action.target, plan);
    decision = {
      action: { type: 'pit', targetCellId: action.target.id, setup: structuredClone(setup) },
      trace,
      targets
    };
  } else {
    decision = { action: { type: 'move', targetCellId: action.target.id }, trace, targets };
  }
  if (level !== 'hard') return decision;
  return decideHardBotAction(ctx, state, car, decision, {
    applyAction,
    decideNormal: (c, s) => decideBotAction(c, s, 'normal')
  });
}
