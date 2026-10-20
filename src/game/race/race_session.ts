// The race as one player's page sees it, without Phaser: the solo turn loop (the human's action, then the bots
// until a human is on turn), the online state from the server, who may control the active car, the HUD snapshot,
// the feel events and the sandbox edits. RaceScene owns one and only draws it; tests drive it directly.
import { DRAFT_SLINGSHOT_TURNS } from '../constants';
import { must } from '../must';
import { DEFAULT_RULES_VERSION, rulesOf, type RulesVersion } from '../rules/versions';
import type { BotLevel, Car } from '../types/car';
import type { TrackCell, TrackData } from '../types/track';
import { laneWearFactors, setupFactors, type TargetInfo } from '../systems/movement_system';
import { buildPlanContext, type BotPlanContext } from '../systems/bot_plan';
import { rankPosition } from '../systems/track_index';
import { pitAdvice, stintEstimate } from '../systems/strategy';
import { createFeelMemory, detectFeel, type FeelEvent } from '../systems/feel_events';
import { computeMoveSpend, getRemainingBudget } from '../systems/move_budget_system';
import { carColor } from '../systems/spawn_system';
import { movePath } from '../systems/move_path';
import { hasFinishedRace, lapInProgress } from '../systems/lap_progress';
import { sortCarsByProgress } from '../systems/ordering_system';
import { carsMovedInOrder, feedLines, type FeedKind, type FeedLine } from '../systems/race_feed';
import { PERSONALITIES, personalityOf } from '../systems/bot_style';
import {
  applyAction,
  computeTargets,
  createRace,
  createRaceContext,
  decideBotAction,
  type RaceAction,
  type RaceContext,
  type RaceSeat,
  type RaceState
} from './race_engine';
import {
  budgetLeftOf,
  editCar,
  placeCar,
  type CarEdit,
  restorePosition,
  setActiveCar
} from './sandbox';
import {
  appendBotDecisionEntry,
  buildBotDecisionSnapshot,
  serializeBotTargets,
  serializeBotTrace,
  type BotDecisionLogEntry
} from '../scenes/debug/bot_decision_debug';
import { buildGameDebugSnapshot } from '../scenes/debug/game_debug_snapshot';
import type { HudCar, HudHover, HudMove, HudSnapshot } from '../../ui/hud';
import type { SandboxSnapshot } from '../../ui/sandbox_panel';
import type { PitStints } from '../scenes/ui/pit_modal';
import type { AppliedTurnSummary, PublicLobby, TurnSource } from '../../net/backend_api';
import { toEngineRace } from '../../net/race_sync';

export interface RaceSessionSetup {
  totalCars: number;
  humanCars: number;
  botCars: number;
  raceLaps: number;
  botLevel?: BotLevel;
  seed?: number;
  /** The movement rules to play on (solo; an online race plays what the server plays). */
  rulesVersion?: RulesVersion;
  /** `?sandbox`: starts in edit mode. */
  sandbox?: boolean;
}

/** What only the scene knows, for the HUD snapshot. */
export interface HudView {
  hoverCell: TrackCell | null;
  showCarsAndMoves: boolean;
  showForwardIndex: boolean;
  /** Page coordinates of a cell (the hover tooltip is placed there). */
  cellScreenPos: (cellId: string) => { x: number; y: number } | null;
}

/** What an online server state changed, for the scene to redraw. */
export interface ServerStateResult {
  /** The lobby's car composition changed: a fresh local race was built, every token must be respawned. */
  respawned: boolean;
  /** The server's race replaced ours. */
  applied: boolean;
}

/** One move of a car, kept to show the followed car's last lap (#135). */
export interface CarMove extends HudMove {
  /** The cells it drove through, first cell included (movePath): the board's trail. */
  path: string[];
  /** Where it ended, in cells from the start line (as HudCar.progress). */
  progress: number;
}

/** The move points a move spent, from the car's move cycle; null when the cycle rolled over and cleared them. */
function spentOn(prev: Car, car: Car): number | null {
  const cycle = car.moveCycle;
  return cycle.index === prev.moveCycle.index + 1
    ? (cycle.spent[prev.moveCycle.index] ?? null)
    : null;
}

const BOT_LOG_LIMIT = 1000;
const LOG_LIMIT = 30;
/** Feed lines kept, so a followed car still has LOG_LIMIT lines of its own among the others'. */
const FEED_LIMIT = 500;
/** Moves kept per car: a lap is about 7 moves, more with pit stops and short moves on empty tires. */
const MOVES_PER_CAR = 24;
/** Online: input stays locked this long after sending a turn, unless the server answers first. */
/** The path of the move the player is about to make, with how the board should draw it. */
export interface MovePreview {
  cellId: string;
  kind: 'move' | 'slingshot' | 'squeeze' | 'pit';
  cells: string[];
}

export const SERVER_WAIT_MS = 5000;
const HUD_LABELS = {
  noneTags: 'none',
  targetPrefix: 'target:',
  factorsPrefix: 'factors:',
  validTargetsPrefix: 'valid targets:'
};
const BUILD_INFO = { version: 'debug-snapshot-v3', gitSha: __GIT_SHA__ };

export class RaceSession {
  readonly track: TrackData;
  readonly ctx: RaceContext;
  readonly sandbox: boolean;
  // Rules and race state live in the engine; the session only drives it.
  race: RaceState = {
    cars: [],
    turn: { order: [], index: 0 },
    raceLaps: 5,
    winnerCarId: null,
    seed: 0
  };
  validTargets: Map<string, TargetInfo> = new Map();
  /** Tap to move: the target cell the local player picked and has not confirmed yet. */
  private selectedCellId: string | null = null;
  editing: boolean;
  private readonly feed: FeedLine[] = [];
  readonly botDecisionLog: BotDecisionLogEntry[] = [];
  private botDecisionSeq = 1;
  private carNames = new Map<number, string>();
  private totalCars: number;
  private humanCars: number;
  private botCars: number;
  private readonly botLevel: BotLevel;
  private readonly seed: number;
  private readonly rulesVersion: RulesVersion;
  // Multiplayer: after sending a turn, wait for the server's race.state before accepting input.
  private awaitingServerUntil = 0;
  private backendLobbyId: string | null = null;
  private localPlayerId: string | null = null;
  private raceFinishedAnnounced = false;
  private feel = createFeelMemory();
  private feelSeededOnline = false;

  constructor(track: TrackData, setup: RaceSessionSetup) {
    this.track = track;
    this.ctx = createRaceContext(track);
    this.totalCars = setup.totalCars;
    this.humanCars = setup.humanCars;
    this.botCars = setup.botCars;
    this.botLevel = setup.botLevel ?? 'normal';
    this.seed = setup.seed ?? 0;
    this.rulesVersion = setup.rulesVersion ?? DEFAULT_RULES_VERSION;
    this.sandbox = setup.sandbox === true;
    this.editing = this.sandbox;
    this.startRace(setup.raceLaps);
  }

  get cellMap(): Map<string, TrackCell> {
    return this.ctx.cellMap;
  }
  get cars(): Car[] {
    return this.race.cars;
  }
  get raceLaps(): number {
    return this.race.raceLaps;
  }
  get finished(): boolean {
    return this.race.winnerCarId !== null;
  }
  get winnerCarId(): number | null {
    return this.race.winnerCarId;
  }
  get activeCar(): Car {
    const { cars, turn } = this.race;
    return (cars.find((c) => c.carId === turn.order[turn.index]) ?? cars[0]) as Car;
  }
  get online(): boolean {
    return this.backendLobbyId != null;
  }

  /** The race feed as shown, oldest first: the last LOG_LIMIT lines, only the followed car's while one is (#135). */
  get logLines(): FeedLine[] {
    const lines =
      this.followedCarId === null
        ? this.feed
        : this.feed.filter((line) => line.carId === this.followedCarId);
    return lines.slice(-LOG_LIMIT);
  }

  addLog(text: string, kind: FeedKind = 'info') {
    this.pushFeed({ text, kind });
  }

  private pushFeed(line: FeedLine) {
    this.feed.push(line);
    if (this.feed.length > FEED_LIMIT) this.feed.shift();
  }

  // What the cars did between two states, as the feed says it (the same lines solo and online, #92).
  private addFeed(before: RaceState) {
    for (const line of feedLines(this.ctx, before, this.race, (car) => this.nameOf(car))) {
      this.pushFeed(line);
    }
  }

  private nameOf(car: Car): string {
    return (
      this.carNames.get(car.carId) ?? (!this.online && !car.isBot ? 'You' : `Car ${car.carId}`)
    );
  }

  // Local seats: humans first, then bots.
  private buildSeats(): RaceSeat[] {
    const seats: RaceSeat[] = [
      ...Array.from({ length: this.humanCars }, (_slot, i) => ({
        isBot: false,
        ownerId: `P${i + 1}`
      })),
      ...Array.from({ length: this.botCars }, (_slot, i) => ({
        isBot: true,
        ownerId: `BOT${i + 1}`,
        botLevel: this.botLevel
      }))
    ];
    return seats.length > 0 ? seats : [{ isBot: false, ownerId: 'P1' }];
  }

  private startRace(raceLaps: number) {
    this.race = createRace(this.ctx, this.buildSeats(), raceLaps, this.seed, this.rulesVersion);
  }

  private respawnForComposition(totalCars: number, humanCars: number, botCars: number) {
    this.totalCars = Math.max(1, Math.min(11, Math.trunc(totalCars)));
    this.humanCars = Math.max(0, Math.min(this.totalCars, Math.trunc(humanCars)));
    this.botCars = Math.max(0, Math.min(this.totalCars - this.humanCars, Math.trunc(botCars)));
    this.startRace(this.race.raceLaps);
    this.validTargets = new Map();
    this.carMoves.clear();
    this.followedCarId = null;
  }

  // ---- control ---------------------------------------------------------------------------------------------------

  isAwaitingServer(): boolean {
    return Date.now() < this.awaitingServerUntil;
  }

  canControlActiveCar(): boolean {
    if (!this.online) return true;
    if (!this.localPlayerId) return false;
    if (this.isAwaitingServer()) return false;
    return this.activeCar.ownerId === this.localPlayerId;
  }

  // The local player's car (online: their seat; solo: the first human).
  localCar(): Car | undefined {
    return this.online
      ? this.cars.find((car) => car.ownerId === this.localPlayerId)
      : this.cars.find((car) => !car.isBot);
  }

  localCanControl(): boolean {
    return !this.finished && this.canControlActiveCar() && !this.activeCar.isBot;
  }

  /** The grid setup (compound, wing) is open until the car's first turn is played. */
  canSetup(): boolean {
    return (
      !this.finished &&
      !this.editing &&
      !this.activeCar.setupLocked &&
      this.activeCar.state === 'ACTIVE' &&
      this.canControlActiveCar() &&
      !this.activeCar.isBot
    );
  }

  /** Skip is only for a car with no move at all. */
  canSkip(): boolean {
    return (
      !this.finished &&
      !this.editing &&
      this.validTargets.size === 0 &&
      this.activeCar.state === 'ACTIVE' &&
      this.canControlActiveCar()
    );
  }

  /**
   * Online, the server moves the car: until it answers, the car just dropped keeps the place and heading of its
   * target cell instead of sliding back to the old one. That car, while it lasts.
   */
  heldCarId(): number | null {
    return this.isAwaitingServer() ? this.activeCar.carId : null;
  }

  // ---- turns -----------------------------------------------------------------------------------------------------

  /**
   * Applies the active car's action. Solo: through the engine (which rejects anything invalid and leaves the state
   * untouched), then the bots play until a human is on turn. Online: nothing changes here; the caller sends it to
   * the server, whose race.state redraws the board, and input waits for that answer (see `awaitServer`).
   */
  applyLocal(action: RaceAction): boolean {
    this.selectedCellId = null;
    if (this.online) {
      this.awaitServer();
      return true;
    }
    const before = structuredClone(this.race);
    const result = applyAction(this.ctx, this.race, action);
    if (!result.ok) {
      this.addLog(`Action rejected (${result.reason}).`);
      return false;
    }
    this.addFeed(before);
    this.noteMoved(before, result.carId, result.moveSpend);
    return true;
  }

  // Locks input until the server answers; `releaseServerWait` unlocks it if it never does.
  awaitServer(): number {
    this.awaitingServerUntil = Date.now() + SERVER_WAIT_MS;
    return SERVER_WAIT_MS;
  }

  /** After SERVER_WAIT_MS: true when the server never answered and the lock was released now. */
  releaseServerWait(): boolean {
    if (this.awaitingServerUntil === 0 || Date.now() < this.awaitingServerUntil) return false;
    this.awaitingServerUntil = 0;
    return true;
  }

  /** Solo: plays the bots until a human (or nobody: race over, edit mode) is on turn. Returns the bot turns played. */
  runBots(): number {
    if (this.finished || this.editing) return 0;
    if (this.online) return 0;
    const maxBots = Math.max(1, this.cars.length);
    let steps = 0;
    while (this.activeCar.isBot && steps < maxBots && !this.finished) {
      if (!this.playBotTurn()) break;
      steps += 1;
    }
    if (steps > 0) this.selectedCellId = null;
    return steps;
  }

  private playBotTurn(): boolean {
    const car = this.activeCar;
    const turnIndex = this.race.turn.index;
    const decision = decideBotAction(this.ctx, this.race);
    const before = structuredClone(this.race);
    const result = applyAction(this.ctx, this.race, decision.action);
    if (!result.ok) {
      this.addLog(`Bot action rejected (${result.reason}).`);
      return false;
    }
    const action = decision.action;
    this.botDecisionSeq = appendBotDecisionEntry(
      this.botDecisionLog,
      BOT_LOG_LIMIT,
      this.botDecisionSeq,
      turnIndex,
      car,
      {
        validTargets: serializeBotTargets(decision.targets),
        action:
          action.type === 'skip' || action.type === 'setup'
            ? { type: 'skip', note: decision.skipNote ?? 'no-target' }
            : { type: action.type, targetCellId: action.targetCellId, moveSpend: result.moveSpend },
        trace: serializeBotTrace(decision.trace)
      },
      result.fromCellId
    );
    this.addFeed(before);
    this.noteMoved(before, result.carId, result.moveSpend);
    return true;
  }

  /** The targets the active car is offered right now. Returns the bot turns it had to play first (solo). */
  recomputeTargets(): number {
    if (this.finished) {
      this.validTargets = new Map();
      return 0;
    }
    if (this.editing) {
      // sandbox: show what the engine offers to whoever is active, bot or not
      this.validTargets = computeTargets(this.ctx, this.race, this.activeCar);
      return 0;
    }
    if (this.online && !this.canControlActiveCar()) {
      this.validTargets = new Map();
      return 0;
    }
    let steps = 0;
    if (this.activeCar.isBot) {
      steps = this.runBots();
      if (this.activeCar.isBot) return steps;
    }
    this.validTargets = computeTargets(this.ctx, this.race, this.activeCar);
    return steps;
  }

  // ---- online ----------------------------------------------------------------------------------------------------

  // Multiplayer: the server owns the race. Replace our state with its snapshot.
  applyServerState(lobby: PublicLobby, localPlayerId: string | null): ServerStateResult {
    this.backendLobbyId = lobby.lobbyId;
    this.localPlayerId = localPlayerId;
    this.awaitingServerUntil = 0;
    let respawned = false;
    if (
      lobby.settings.totalCars !== this.totalCars ||
      lobby.settings.humanCars !== this.humanCars ||
      lobby.settings.botCars !== this.botCars
    ) {
      this.respawnForComposition(
        lobby.settings.totalCars,
        lobby.settings.humanCars,
        lobby.settings.botCars
      );
      respawned = true;
    }
    const raceState = lobby.raceState;
    if (!raceState || (lobby.status !== 'IN_RACE' && lobby.status !== 'FINISHED')) {
      return { respawned, applied: false };
    }

    this.selectedCellId = null;
    const before = this.feelSeededOnline ? this.race : null;
    this.race = toEngineRace(raceState);
    this.carNames = new Map(raceState.cars.map((car) => [car.carId, car.name]));
    if (before) {
      this.addFeed(before);
      this.noteServerMoves(before);
    }
    if (!this.feelSeededOnline) {
      // the first server state is where we join or rejoin: it seeds, it must not celebrate
      this.feelSeededOnline = true;
      this.feel = createFeelMemory();
    }
    return { respawned, applied: true };
  }

  // The cars that moved since the last state, in the order they moved in (a state can carry several turns).
  private noteServerMoves(before: RaceState) {
    // the cars stand where they stood until their own move comes up in the order
    const standing = new Map(before.cars.map((car) => [car.carId, car.cellId]));
    for (const car of carsMovedInOrder(before, this.race)) {
      const from = standing.get(car.carId) ?? null;
      standing.set(car.carId, car.cellId);
      if (!this.movedCars.includes(car.carId)) this.movedCars.push(car.carId);
      if (from) {
        const blocked = new Set(
          [...standing].filter(([id]) => id !== car.carId).map(([, cellId]) => cellId)
        );
        const path = movePath(this.ctx.trackIndex, from, car.cellId, blocked);
        this.lastPaths.set(car.carId, path);
        const prev = before.cars.find((c) => c.carId === car.carId);
        if (prev) this.recordMove(prev, car, path, spentOn(prev, car));
      }
    }
  }

  // Remote and own turns alike arrive as events; the board itself redraws from race.state.
  applyTurnApplied(
    lobbyId: string,
    playerId: string,
    _action: AppliedTurnSummary,
    source?: TurnSource
  ) {
    if (this.backendLobbyId && lobbyId !== this.backendLobbyId) return;
    const car = this.cars.find((candidate) => candidate.ownerId === playerId);
    // what the turn did is said from the state diff (applyServerState); only the way it was played is not in the state
    if (car && (source === 'timeout' || source === 'force_skip')) {
      this.addLog(
        `${this.nameOf(car)} was auto-played (${source === 'timeout' ? 'timeout' : 'host skip'})`
      );
    }
  }

  // ---- moves, for the board to animate ------------------------------------------------------------------------------

  // Cars that changed cell since the board last looked, in the order they moved (a car appears once).
  private movedCars: number[] = [];

  // The cells each car drove through on its last move (movePath, round the cars standing there when it moved): the
  // board's trail, and "what happened while I waited". A car keeps its trail until it moves again.
  private readonly lastPaths = new Map<number, string[]>();

  private noteMoved(before: RaceState, carId: number, moveSpend: number) {
    const car = this.cars.find((c) => c.carId === carId);
    const prev = before.cars.find((c) => c.carId === carId);
    if (!car || !prev || car.cellId === prev.cellId) return;
    if (!this.movedCars.includes(carId)) this.movedCars.push(carId);
    const blocked = new Set(this.cars.filter((c) => c.carId !== carId).map((c) => c.cellId));
    const path = movePath(this.ctx.trackIndex, prev.cellId, car.cellId, blocked);
    this.lastPaths.set(carId, path);
    this.recordMove(prev, car, path, moveSpend);
  }

  // ---- following one car (#135) ----------------------------------------------------------------------------------

  // Each car's recent moves, oldest first (at most MOVES_PER_CAR): the followed car's last lap, listed and drawn.
  private readonly carMoves = new Map<number, CarMove[]>();
  private followedCarId: number | null = null;

  /** Cells from the start line, as the standings and the feed measure them (laps * spineLen + lap position). */
  private cellsFromStart(car: Car): number {
    return (
      (car.lapCount ?? 0) * this.ctx.trackIndex.spineLen +
      rankPosition(this.ctx.trackIndex, must(this.cellMap.get(car.cellId), 'cell of a car'))
    );
  }

  private recordMove(prev: Car, car: Car, path: string[], moveSpend: number | null) {
    const pit = car.tire > prev.tire || car.fuel > prev.fuel;
    const progress = this.cellsFromStart(car);
    const moves = this.carMoves.get(car.carId) ?? [];
    moves.push({
      lap: lapInProgress(car.lapCount, this.raceLaps),
      cells: Math.round(progress - this.cellsFromStart(prev)),
      moveSpend,
      tireUsed: pit ? 0 : Math.max(0, prev.tire - car.tire),
      fuelUsed: pit ? 0 : Math.max(0, prev.fuel - car.fuel),
      pit,
      path,
      progress
    });
    if (moves.length > MOVES_PER_CAR) moves.shift();
    this.carMoves.set(car.carId, moves);
  }

  /** Follows `carId` (null, the car already followed or an unknown car: follows nobody). Returns who is followed. */
  followCar(carId: number | null): number | null {
    const known = carId !== null && this.cars.some((car) => car.carId === carId);
    this.followedCarId = known && carId !== this.followedCarId ? carId : null;
    return this.followedCarId;
  }

  get followed(): number | null {
    return this.followedCarId;
  }

  /** The moves `carId` made over its last lap: those that ended less than a lap behind where it is now. */
  lastLapMoves(carId: number): CarMove[] {
    const car = this.cars.find((c) => c.carId === carId);
    if (!car) return [];
    const since = this.cellsFromStart(car) - this.ctx.trackIndex.spineLen;
    return (this.carMoves.get(carId) ?? []).filter((move) => move.progress > since);
  }

  /** The followed car's last-lap moves; empty while nobody is followed. */
  followedMoves(): CarMove[] {
    return this.followedCarId === null ? [] : this.lastLapMoves(this.followedCarId);
  }

  /**
   * The tows for the board to draw: every car in a tow (its last move ended tucked in behind a car) whose leader is
   * still there. `gap` is the cells to that car (1 to DRAFT_RANGE). Once the leader has moved on there is nothing to
   * draw (a band over empty road read as a glitch): the car is still in the tow for its next move, which the card and
   * the targets' rings say. `ready` is the slingshot being open on its next move.
   */
  draftLinks(): Array<{ carId: number; gap: number; ready: boolean }> {
    const occupied = this.cars.map((c) => c.cellId);
    const links: Array<{ carId: number; gap: number; ready: boolean }> = [];
    for (const car of this.cars) {
      if ((car.draftTurns ?? 0) < 1 || car.state === 'DNF') continue;
      const ahead = rulesOf(this.race).draftAhead(this.ctx.trackIndex, car.cellId, occupied);
      if (ahead) {
        links.push({
          carId: car.carId,
          gap: ahead.gap,
          ready: (car.draftTurns ?? 0) >= DRAFT_SLINGSHOT_TURNS
        });
      }
    }
    return links;
  }

  /** The cells `carId` drove through on its last move, first cell included; empty before it has moved. */
  lastMovePath(carId: number): string[] {
    return this.lastPaths.get(carId) ?? [];
  }

  /**
   * The path of the move the player is about to make, for the board to draw: the picked (tapped) target, else the one
   * under the pointer (hovered or dragged over), when it is one of the car's targets. Null when there is none.
   */
  previewFor(hoverCellId: string | null): MovePreview | null {
    if (this.editing || !this.localCanControl()) return null;
    const cellId = this.selectedTarget()?.cellId ?? hoverCellId;
    const info = cellId ? this.validTargets.get(cellId) : undefined;
    if (!cellId || !info) return null;
    // a squeeze passes through the cars: do not route it round them
    const blocked = info.squeezePassed
      ? new Set<string>()
      : new Set(this.cars.filter((c) => c.carId !== this.activeCar.carId).map((c) => c.cellId));
    const kind: MovePreview['kind'] = info.isPitTrigger
      ? 'pit'
      : info.squeezePassed
        ? 'squeeze'
        : info.slingshot
          ? 'slingshot'
          : 'move';
    return {
      cellId,
      kind,
      cells: movePath(this.ctx.trackIndex, this.activeCar.cellId, cellId, blocked)
    };
  }

  /** The cars that moved since the last call, in the order they moved: the board glides them one after another. */
  drainMoves(): number[] {
    const moved = this.movedCars;
    this.movedCars = [];
    return moved;
  }

  // ---- feel ------------------------------------------------------------------------------------------------------

  /** Lap toasts, finish and sounds for what changed since the last call (nothing on the first one). */
  drainFeel(): FeelEvent[] {
    const events = detectFeel(this.feel, {
      myCarId: this.localCar()?.carId ?? null,
      raceLaps: this.raceLaps,
      finished: this.finished,
      canControl: this.localCanControl(),
      cars: this.cars.map((car) => ({
        carId: car.carId,
        lapCount: car.lapCount ?? 0,
        cellId: car.cellId,
        tire: car.tire,
        fuel: car.fuel,
        slingshots: car.slingshots ?? 0,
        draftTurns: car.draftTurns ?? 0
      }))
    });
    // a lap or a finish drowns the plain move click
    const loud = events.some((e) => e.type !== 'move');
    return events.filter((event) => !(event.type === 'move' && loud));
  }

  /** True once, the first time this is asked after the race finished. */
  takeFinish(): boolean {
    if (!this.finished || this.raceFinishedAnnounced) return false;
    this.raceFinishedAnnounced = true;
    return true;
  }

  // ---- HUD -------------------------------------------------------------------------------------------------------

  moveSpendOf(info: TargetInfo, targetLaneIndex: number): number {
    const fromLaneIndex = this.cellMap.get(this.activeCar.cellId)?.laneIndex ?? targetLaneIndex;
    return info.moveSpend ?? computeMoveSpend(info.distance, fromLaneIndex, targetLaneIndex);
  }

  resourcesAfter(info: TargetInfo) {
    return {
      tire: Math.max(0, this.activeCar.tire - info.tireCost),
      fuel: Math.max(0, this.activeCar.fuel - info.fuelCost)
    };
  }

  // Stint after the refill (100% tire and fuel) for each compound at the wings and psi being set.
  pitStints(setup: Car['setup']): PitStints {
    const spineLen = this.ctx.trackIndex.spineLen;
    const at = (compound: 'soft' | 'hard') =>
      stintEstimate(
        { tire: 100, fuel: 100, setup: { ...setup, compound } },
        spineLen,
        this.resources()
      );
    return { soft: at('soft'), hard: at('hard') };
  }

  /** The move points a cycle holds for this setup (the pit modal shows it as pace). */
  paceOf(setup: Car['setup']): number {
    return this.resources().cycleBudget(setup);
  }

  private resources() {
    return rulesOf(this.race).resources;
  }

  private plan(): BotPlanContext {
    return buildPlanContext(this.ctx.trackIndex, this.raceLaps, this.resources());
  }

  /**
   * True when the active car would end its move on `cellId` tucked in behind a car (1 to DRAFT_RANGE cells ahead in that
   * lane, the cars where they stand now): the move that keeps or starts the tow. The rule reads it after the move.
   */
  endsTucked(cellId: string): boolean {
    const others = this.cars.filter((c) => c.carId !== this.activeCar.carId).map((c) => c.cellId);
    return rulesOf(this.race).draftAhead(this.ctx.trackIndex, cellId, others) !== null;
  }

  /** What the HUD shows for one target: the move and the tire and fuel it leaves (hover tooltip, tap card). */
  private targetHud(
    cell: TrackCell,
    target: TargetInfo,
    pos: { x: number; y: number } | null
  ): HudHover | null {
    if (!pos) return null;
    return {
      ...pos,
      distance: target.distance,
      moveSpend: this.moveSpendOf(target, cell.laneIndex),
      tireCost: target.tireCost,
      fuelCost: target.fuelCost,
      isPit: target.isPitTrigger,
      ...(target.squeezePassed ? { squeezePassed: target.squeezePassed } : {}),
      ...(target.laneChanges ? { laneChanges: target.laneChanges } : {}),
      ...(target.drafted ? { drafted: true } : {}),
      ...(target.slingshot ? { slingshot: true } : {}),
      ...(target.slingshotOnly ? { slingshotOnly: true } : {}),
      ...(this.endsTucked(cell.id) ? { tucksIn: true } : {}),
      tireBefore: this.activeCar.tire,
      fuelBefore: this.activeCar.fuel
    };
  }

  // ---- tap to move ---------------------------------------------------------------------------------------------

  /** Picks one of the active car's targets to confirm later. False (and nothing picked) when the player may not. */
  selectTarget(cellId: string): boolean {
    if (this.editing || !this.localCanControl() || !this.validTargets.has(cellId)) {
      this.selectedCellId = null;
      return false;
    }
    this.selectedCellId = cellId;
    return true;
  }

  clearSelection() {
    this.selectedCellId = null;
  }

  /** The picked target while it is still one the local player may play; a stale pick is dropped. */
  selectedTarget(): { cellId: string; info: TargetInfo } | null {
    const cellId = this.selectedCellId;
    const info = cellId ? this.validTargets.get(cellId) : undefined;
    if (!cellId || !info || this.editing || !this.localCanControl()) {
      this.selectedCellId = null;
      return null;
    }
    return { cellId, info };
  }

  private hudCar(car: Car): HudCar {
    const index = this.cars.indexOf(car);
    return {
      carId: car.carId,
      name: this.nameOf(car),
      color: carColor(index),
      isBot: car.isBot,
      // Bots only (a human's style is never shown); seed 0 is the neutral baseline, nothing to show.
      ...(car.isBot && car.botLevel === 'hard'
        ? { style: PERSONALITIES.adaptive.label }
        : car.isBot && this.race.seed
          ? { style: personalityOf(this.race.seed, car.carId).label }
          : {}),
      lap: lapInProgress(car.lapCount, this.raceLaps),
      finished: hasFinishedRace(car.lapCount, this.raceLaps),
      // the display's own measure (lap position, as the standings): the bots keep progressOf, which they are tuned on
      progress: this.cellsFromStart(car),
      fwd: this.cellMap.get(car.cellId)?.forwardIndex ?? -1,
      tire: car.tire,
      fuel: car.fuel,
      compound: car.setup.compound,
      wing: car.setup.wing,
      state: car.state,
      pitTurns: car.pitTurnsRemaining,
      cycle: [...car.moveCycle.spent],
      cycleIndex: car.moveCycle.index,
      remaining: getRemainingBudget(car.moveCycle, this.resources().cycleBudget(car.setup)),
      budget: this.resources().cycleBudget(car.setup),
      pitServiced: car.pitServiced,
      // tucked in: the car ended its last move behind a car, so its next move is in the tow (the leader may be gone)
      drafting: (car.draftTurns ?? 0) >= 1,
      draftTurns: car.draftTurns ?? 0,
      stint: stintEstimate(car, this.ctx.trackIndex.spineLen, this.resources()),
      advice: pitAdvice(car, must(this.cellMap.get(car.cellId), 'cell of a car'), this.plan())
    };
  }

  // One plain snapshot for the DOM HUD (src/ui/hud.ts); null before there is a car.
  hudSnapshot(view: HudView): HudSnapshot | null {
    if (this.cars.length === 0) return null;
    const mine = this.localCar();
    const ordered = sortCarsByProgress(this.cars, this.cellMap, {
      turnOrder: this.race.turn.order,
      turnIndex: this.race.turn.index,
      trackIndex: this.ctx.trackIndex
    });
    const { hoverCell } = view;
    const selected = this.selectedTarget();
    const selectedCell = selected ? this.cellMap.get(selected.cellId) : undefined;
    const selection =
      selected && selectedCell && view.showCarsAndMoves
        ? this.targetHud(selectedCell, selected.info, view.cellScreenPos(selectedCell.id))
        : null;
    // while a target is picked, its card replaces the hover tooltip (on a phone the last tap would hover it too)
    const target = hoverCell && !selection ? this.validTargets.get(hoverCell.id) : undefined;
    return {
      raceLaps: this.raceLaps,
      spineLen: this.ctx.trackIndex.spineLen,
      finished: this.finished,
      winnerCarId: this.winnerCarId,
      myCarId: mine?.carId ?? null,
      activeCarId: this.activeCar.carId,
      canControl: this.localCanControl(),
      cars: ordered.map((car) => this.hudCar(car)),
      ...(this.sandbox ? { sandbox: this.editing ? ('edit' as const) : ('play' as const) } : {}),
      boxedIn: [...this.validTargets.values()].some((t) => t.squeezePassed !== undefined),
      pitExitBlocked: this.cellMap.get(this.activeCar.cellId)?.tags?.includes('PIT_EXIT') ?? false,
      hover:
        hoverCell && target && view.showCarsAndMoves
          ? this.targetHud(hoverCell, target, view.cellScreenPos(hoverCell.id))
          : null,
      selection,
      debugText: view.showForwardIndex ? this.makeHudText(hoverCell) : null,
      log: this.logLines.map(({ text, kind, carId }) => ({
        text,
        kind,
        mine: carId !== undefined && carId === mine?.carId
      })),
      follow:
        this.followedCarId === null
          ? null
          : {
              carId: this.followedCarId,
              moves: this.followedMoves().map(
                ({ lap, cells, moveSpend, tireUsed, fuelUsed, pit }): HudMove => ({
                  lap,
                  cells,
                  moveSpend,
                  tireUsed,
                  fuelUsed,
                  pit
                })
              )
            }
    };
  }

  private makeHudText(cell: TrackCell | null): string {
    if (!cell) {
      const activeStatus = [
        `Active: Car ${this.activeCar.carId}`,
        `Lap: ${lapInProgress(this.activeCar.lapCount, this.raceLaps)}/${this.raceLaps}`,
        `Tire: ${this.activeCar.tire}%`,
        `Fuel: ${this.activeCar.fuel}%`
      ].join('\n');
      return [activeStatus, `${HUD_LABELS.validTargetsPrefix} ${this.validTargets.size}`].join(
        '\n'
      );
    }

    const tags = (cell.tags ?? []).join(', ') || HUD_LABELS.noneTags;
    const targetInfo = this.validTargets.get(cell.id);
    const factors = targetInfo ? this.computeCostFactors(cell.laneIndex) : null;
    const targetLine = targetInfo
      ? `${HUD_LABELS.targetPrefix} d${targetInfo.distance}  tire-${targetInfo.tireCost}  fuel-${targetInfo.fuelCost}${targetInfo.isPitTrigger ? '  PIT' : ''}`
      : null;
    const factorLine = factors
      ? `${HUD_LABELS.factorsPrefix} aeroT x${factors.aeroT.toFixed(2)}  aeroF x${factors.aeroF.toFixed(2)}  psi x${factors.psi.toFixed(2)}  laneT x${factors.laneT.toFixed(2)}  laneF x${factors.laneF.toFixed(2)}`
      : null;
    return [
      `cell: ${cell.id}`,
      `zone: ${cell.zoneIndex}  lane: ${cell.laneIndex}`,
      `lap: ${lapInProgress(this.activeCar.lapCount, this.raceLaps)}  fwd: ${cell.forwardIndex}`,
      `tags: ${tags}`,
      `next: ${cell.next.length}`,
      ...(targetLine ? [targetLine] : []),
      ...(factorLine ? [factorLine] : []),
      `${HUD_LABELS.validTargetsPrefix} ${this.validTargets.size}`
    ].join('\n');
  }

  private computeCostFactors(laneIndex: number) {
    const { aeroTire, aeroFuel, psiFactor } = setupFactors(this.activeCar.setup);
    const lane = laneWearFactors(laneIndex);
    return { aeroT: aeroTire, aeroF: aeroFuel, psi: psiFactor, laneT: lane.tire, laneF: lane.fuel };
  }

  // ---- debug -----------------------------------------------------------------------------------------------------

  debugSnapshot() {
    return buildGameDebugSnapshot({
      buildInfo: BUILD_INFO,
      track: this.track,
      cellMap: this.cellMap,
      cars: this.cars,
      activeCar: this.activeCar,
      validTargets: this.validTargets,
      botDecisionCount: this.botDecisionLog.length,
      resources: this.resources(),
      disallowPitBoxTargets: this.activeCar.pitServiced,
      seed: this.race.seed,
      rulesVersion: this.race.rulesVersion ?? DEFAULT_RULES_VERSION
    });
  }

  botDecisionSnapshot(shortMode = false) {
    return buildBotDecisionSnapshot(BUILD_INFO, this.track.trackId, this.botDecisionLog, shortMode);
  }

  // ---- sandbox (`?sandbox`) --------------------------------------------------------------------------------------
  // After every edit the caller redraws, and nothing celebrates (a teleported car is no lap, no overtake).

  sandboxSnapshot(): SandboxSnapshot {
    const car = this.activeCar;
    return {
      editing: this.editing,
      activeCarId: car.carId,
      carIds: this.cars.map((c) => c.carId),
      raceLaps: this.raceLaps,
      car: {
        cellId: car.cellId,
        lapCount: car.lapCount ?? 0,
        tire: car.tire,
        fuel: car.fuel,
        compound: car.setup.compound,
        wing: car.setup.wing,
        budgetLeft: budgetLeftOf(car, this.resources()),
        draftTurns: car.draftTurns ?? 0,
        isBot: car.isBot,
        botLevel: car.botLevel ?? 'normal'
      }
    };
  }

  resetFeel() {
    this.feel = createFeelMemory();
  }

  sandboxEdit(carId: number, edit: CarEdit) {
    const refused = editCar(this.ctx, this.race, carId, edit);
    if (refused) this.addLog(refused);
    this.resetFeel();
    this.carMoves.clear(); // a teleport is no move: the history starts over from the edited position
  }

  // A drop on a free cell moves the car, on another car swaps them; away from any cell the car goes back.
  sandboxDrop(carId: number, cellId: string | null) {
    const refused = cellId ? placeCar(this.ctx, this.race, carId, cellId) : null;
    if (refused) this.addLog(refused);
    this.resetFeel();
    this.carMoves.clear();
  }

  /** False when nothing changed (already active, or no such car). */
  sandboxSelect(carId: number): boolean {
    if (carId === this.activeCar.carId || !setActiveCar(this.race, carId)) return false;
    this.resetFeel();
    return true;
  }

  setEditing(editing: boolean) {
    this.editing = editing;
    this.selectedCellId = null;
    this.addLog(editing ? 'Sandbox: editing.' : 'Sandbox: playing from here.');
    this.resetFeel();
  }

  // Puts a "Copy debug" snapshot in place.
  loadPosition(text: string) {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(text);
    } catch {
      this.addLog('Load refused: not JSON.');
      return;
    }
    const refused = restorePosition(this.ctx, this.race, snapshot);
    if (!refused) this.carMoves.clear();
    this.addLog(refused ? `Load refused: ${refused}` : 'Position loaded.');
  }
}
