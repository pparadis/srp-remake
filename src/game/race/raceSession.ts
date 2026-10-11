// The race as one player's page sees it, without Phaser: the solo turn loop (the human's action, then the bots
// until a human is on turn), the online state from the server, who may control the active car, the HUD snapshot,
// the feel events and the sandbox edits. RaceScene owns one and only draws it; tests drive it directly.
import { MOVE_BUDGET, MOVE_RATES } from "../constants";
import type { BotLevel, Car } from "../types/car";
import type { TrackCell, TrackData } from "../types/track";
import { laneWearFactors, setupFactors, type TargetInfo } from "../systems/movementSystem";
import { buildPlanContext, progressOf, type BotPlanContext } from "../systems/botPlan";
import { pitAdvice, stintEstimate } from "../systems/strategy";
import { createFeelMemory, detectFeel, type FeelEvent } from "../systems/feelEvents";
import { computeMoveSpend, getRemainingBudget } from "../systems/moveBudgetSystem";
import { carColor } from "../systems/spawnSystem";
import { hasFinishedRace, lapInProgress } from "../systems/lapProgress";
import { sortCarsByProgress } from "../systems/orderingSystem";
import { PERSONALITIES, personalityOf } from "../systems/botStyle";
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
} from "./raceEngine";
import { budgetLeftOf, editCar, placeCar, type CarEdit, restorePosition, setActiveCar } from "./sandbox";
import {
  appendBotDecisionEntry,
  buildBotDecisionSnapshot,
  serializeBotTargets,
  serializeBotTrace,
  type BotDecisionLogEntry
} from "../scenes/debug/botDecisionDebug";
import { buildGameDebugSnapshot } from "../scenes/debug/gameDebugSnapshot";
import type { HudCar, HudHover, HudSnapshot } from "../../ui/hud";
import type { SandboxSnapshot } from "../../ui/sandboxPanel";
import type { PitStints } from "../scenes/ui/PitModal";
import type { AppliedTurnSummary, PublicLobby, TurnSource } from "../../net/backendApi";
import { toEngineRace } from "../../net/raceSync";

export interface RaceSessionSetup {
  totalCars: number;
  humanCars: number;
  botCars: number;
  raceLaps: number;
  botLevel?: BotLevel;
  seed?: number;
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

const BOT_LOG_LIMIT = 1000;
const LOG_LIMIT = 30;
/** Online: input stays locked this long after sending a turn, unless the server answers first. */
export const SERVER_WAIT_MS = 5000;
const HUD_LABELS = {
  noneTags: "none",
  targetPrefix: "target:",
  factorsPrefix: "factors:",
  validTargetsPrefix: "valid targets:"
};
const BUILD_INFO = { version: "debug-snapshot-v3", gitSha: __GIT_SHA__ };

export class RaceSession {
  readonly track: TrackData;
  readonly ctx: RaceContext;
  readonly sandbox: boolean;
  // Rules and race state live in the engine; the session only drives it.
  race: RaceState = { cars: [], turn: { order: [], index: 0 }, raceLaps: 5, winnerCarId: null, seed: 0 };
  validTargets: Map<string, TargetInfo> = new Map();
  /** Tap to move: the target cell the local player picked and has not confirmed yet. */
  private selectedCellId: string | null = null;
  editing: boolean;
  readonly logLines: string[] = [];
  readonly botDecisionLog: BotDecisionLogEntry[] = [];
  private botDecisionSeq = 1;
  private carNames = new Map<number, string>();
  private totalCars: number;
  private humanCars: number;
  private botCars: number;
  private readonly botLevel: BotLevel;
  private readonly seed: number;
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
    this.botLevel = setup.botLevel ?? "normal";
    this.seed = setup.seed ?? 0;
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

  addLog(line: string) {
    this.logLines.push(line);
    if (this.logLines.length > LOG_LIMIT) this.logLines.shift();
  }

  // Local seats: humans first, then bots.
  private buildSeats(): RaceSeat[] {
    const seats: RaceSeat[] = [
      ...Array.from({ length: this.humanCars }, (_, i) => ({ isBot: false, ownerId: `P${i + 1}` })),
      ...Array.from({ length: this.botCars }, (_, i) => ({
        isBot: true,
        ownerId: `BOT${i + 1}`,
        botLevel: this.botLevel
      }))
    ];
    return seats.length > 0 ? seats : [{ isBot: false, ownerId: "P1" }];
  }

  private startRace(raceLaps: number) {
    this.race = createRace(this.ctx, this.buildSeats(), raceLaps, this.seed);
  }

  private respawnForComposition(totalCars: number, humanCars: number, botCars: number) {
    this.totalCars = Math.max(1, Math.min(11, Math.trunc(totalCars)));
    this.humanCars = Math.max(0, Math.min(this.totalCars, Math.trunc(humanCars)));
    this.botCars = Math.max(0, Math.min(this.totalCars - this.humanCars, Math.trunc(botCars)));
    this.startRace(this.race.raceLaps);
    this.validTargets = new Map();
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

  /** Skip is only for a car with no move at all. */
  canSkip(): boolean {
    return (
      !this.finished &&
      !this.editing &&
      this.validTargets.size === 0 &&
      this.activeCar.state === "ACTIVE" &&
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
    const result = applyAction(this.ctx, this.race, action);
    if (!result.ok) {
      this.addLog(`Action rejected (${result.reason}).`);
      return false;
    }
    for (const line of result.log) this.addLog(line);
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
          action.type === "skip"
            ? { type: "skip", note: decision.skipNote ?? "no-target" }
            : { type: action.type, targetCellId: action.targetCellId, moveSpend: result.moveSpend },
        trace: serializeBotTrace(decision.trace)
      },
      result.fromCellId
    );
    for (const line of result.log) this.addLog(line);
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
      this.respawnForComposition(lobby.settings.totalCars, lobby.settings.humanCars, lobby.settings.botCars);
      respawned = true;
    }
    const raceState = lobby.raceState;
    if (!raceState || (lobby.status !== "IN_RACE" && lobby.status !== "FINISHED")) return { respawned, applied: false };

    this.selectedCellId = null;
    const wasFinished = this.finished;
    this.race = toEngineRace(raceState);
    if (!this.feelSeededOnline) {
      // the first server state is where we join or rejoin: it seeds, it must not celebrate
      this.feelSeededOnline = true;
      this.feel = createFeelMemory();
    }
    this.carNames = new Map(raceState.cars.map((car) => [car.carId, car.name]));
    if (this.finished && !wasFinished) {
      this.addLog(`Race finished. Car ${this.winnerCarId} wins the ${this.raceLaps}-lap race.`);
    }
    return { respawned, applied: true };
  }

  // Remote and own turns alike arrive as events; the board itself redraws from race.state.
  applyTurnApplied(lobbyId: string, playerId: string, action: AppliedTurnSummary, source?: TurnSource) {
    if (this.backendLobbyId && lobbyId !== this.backendLobbyId) return;
    const car = this.cars.find((candidate) => candidate.ownerId === playerId);
    if (!car) return;
    if (source === "timeout" || source === "force_skip") {
      this.addLog(`Car ${car.carId} was auto-played (${source === "timeout" ? "timeout" : "host skip"}).`);
    }
    if (action.type === "skip") {
      this.addLog(`Car ${car.carId} skipped (no moves).`);
    } else if (action.type === "pit") {
      this.addLog(`Car ${car.carId} pit stop at ${action.targetCellId ?? "?"}.`);
    } else {
      this.addLog(`Car ${car.carId} moved to ${action.targetCellId ?? "?"}.`);
    }
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
        fuel: car.fuel
      }))
    });
    // a lap or a finish drowns the plain move click
    const loud = events.some((e) => e.type !== "move");
    return events.filter((event) => !(event.type === "move" && loud));
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
  pitStints(setup: Car["setup"]): PitStints {
    const spineLen = this.ctx.trackIndex.spineLen;
    const at = (compound: "soft" | "hard") => stintEstimate({ tire: 100, fuel: 100, setup: { ...setup, compound } }, spineLen);
    return { soft: at("soft"), hard: at("hard") };
  }

  private plan(): BotPlanContext {
    return buildPlanContext(this.ctx.trackIndex, this.raceLaps);
  }

  /** What the HUD shows for one target: the move and the tire and fuel it leaves (hover tooltip, tap card). */
  private targetHud(cell: TrackCell, target: TargetInfo, pos: { x: number; y: number } | null): HudHover | null {
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
    const solo = !this.online;
    return {
      carId: car.carId,
      name: this.carNames.get(car.carId) ?? (solo && !car.isBot ? "You" : `Car ${car.carId}`),
      color: carColor(index),
      isBot: car.isBot,
      // Bots only (a human's style is never shown); seed 0 is the neutral baseline, nothing to show.
      ...(car.isBot && car.botLevel === "hard" ? { style: PERSONALITIES.adaptive.label } : car.isBot && this.race.seed ? { style: personalityOf(this.race.seed, car.carId).label } : {}),
      lap: lapInProgress(car.lapCount, this.raceLaps),
      finished: hasFinishedRace(car.lapCount, this.raceLaps),
      progress: progressOf(car, this.cellMap.get(car.cellId)!, this.plan()),
      fwd: this.cellMap.get(car.cellId)?.forwardIndex ?? -1,
      tire: car.tire,
      fuel: car.fuel,
      compound: car.setup.compound,
      state: car.state,
      pitTurns: car.pitTurnsRemaining,
      cycle: [...car.moveCycle.spent],
      cycleIndex: car.moveCycle.index,
      remaining: getRemainingBudget(car.moveCycle),
      pitServiced: car.pitServiced,
      stint: stintEstimate(car, this.ctx.trackIndex.spineLen),
      advice: pitAdvice(car, this.cellMap.get(car.cellId)!, this.plan())
    };
  }

  // One plain snapshot for the DOM HUD (src/ui/hud.ts); null before there is a car.
  hudSnapshot(view: HudView): HudSnapshot | null {
    if (this.cars.length === 0) return null;
    const mine = this.localCar();
    const ordered = sortCarsByProgress(this.cars, this.cellMap, {
      turnOrder: this.race.turn.order,
      turnIndex: this.race.turn.index
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
      ...(this.sandbox ? { sandbox: this.editing ? ("edit" as const) : ("play" as const) } : {}),
      boxedIn: [...this.validTargets.values()].some((t) => t.squeezePassed !== undefined),
      pitExitBlocked: this.cellMap.get(this.activeCar.cellId)?.tags?.includes("PIT_EXIT") ?? false,
      hover:
        hoverCell && target && view.showCarsAndMoves
          ? this.targetHud(hoverCell, target, view.cellScreenPos(hoverCell.id))
          : null,
      selection,
      debugText: view.showForwardIndex ? this.makeHudText(hoverCell) : null,
      log: [...this.logLines]
    };
  }

  private makeHudText(cell: TrackCell | null): string {
    if (!cell) {
      const activeStatus = [
        `Active: Car ${this.activeCar.carId}`,
        `Lap: ${lapInProgress(this.activeCar.lapCount, this.raceLaps)}/${this.raceLaps}`,
        `Tire: ${this.activeCar.tire}%`,
        `Fuel: ${this.activeCar.fuel}%`
      ].join("\n");
      return [activeStatus, `${HUD_LABELS.validTargetsPrefix} ${this.validTargets.size}`].join("\n");
    }

    const tags = (cell.tags ?? []).join(", ") || HUD_LABELS.noneTags;
    const targetInfo = this.validTargets.get(cell.id);
    const factors = targetInfo ? this.computeCostFactors(cell.laneIndex) : null;
    const targetLine = targetInfo
      ? `${HUD_LABELS.targetPrefix} d${targetInfo.distance}  tire-${targetInfo.tireCost}  fuel-${targetInfo.fuelCost}${targetInfo.isPitTrigger ? "  PIT" : ""}`
      : null;
    const factorLine = factors
      ? `${HUD_LABELS.factorsPrefix} aero x${factors.aero.toFixed(2)}  psi x${factors.psi.toFixed(2)}  laneT x${factors.laneT.toFixed(2)}  laneF x${factors.laneF.toFixed(2)}`
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
    ].join("\n");
  }

  private computeCostFactors(laneIndex: number) {
    const { aeroFactor, psiFactor } = setupFactors(this.activeCar.setup);
    const lane = laneWearFactors(laneIndex);
    return { aero: aeroFactor, psi: psiFactor, laneT: lane.tire, laneF: lane.fuel };
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
      moveBudget: MOVE_BUDGET,
      moveRates: MOVE_RATES,
      disallowPitBoxTargets: this.activeCar.pitServiced,
      seed: this.race.seed
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
        budgetLeft: budgetLeftOf(car),
        isBot: car.isBot,
        botLevel: car.botLevel ?? "normal"
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
  }

  // A drop on a free cell moves the car, on another car swaps them; away from any cell the car goes back.
  sandboxDrop(carId: number, cellId: string | null) {
    const refused = cellId ? placeCar(this.ctx, this.race, carId, cellId) : null;
    if (refused) this.addLog(refused);
    this.resetFeel();
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
    this.addLog(editing ? "Sandbox: editing." : "Sandbox: playing from here.");
    this.resetFeel();
  }

  // Puts a "Copy debug" snapshot in place.
  loadPosition(text: string) {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(text);
    } catch {
      this.addLog("Load refused: not JSON.");
      return;
    }
    const refused = restorePosition(this.ctx, this.race, snapshot);
    this.addLog(refused ? `Load refused: ${refused}` : "Position loaded.");
  }
}
