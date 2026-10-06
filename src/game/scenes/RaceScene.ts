import Phaser from "phaser";
import type { TrackData, TrackCell } from "../types/track";
import type { BotLevel, Car } from "../types/car";
import { trackSchema } from "../../validation/trackSchema";
import {
  MOVE_BUDGET,
  MOVE_RATES,
  REG_BOT_CARS,
  REG_BOT_LEVEL,
  REG_HUMAN_CARS,
  REG_RACE_LAPS,
  REG_TOTAL_CARS
} from "../constants";
import { laneWearFactors, setupFactors, type TargetInfo } from "../systems/movementSystem";
import { buildPlanContext, type BotPlanContext } from "../systems/botPlan";
import { pitAdvice, stintEstimate } from "../systems/strategy";
import { createFeelMemory, detectFeel, type FeelEvent } from "../systems/feelEvents";
import { play } from "../../ui/sound";
import { Confetti } from "./ui/Confetti";
import { computeMoveSpend, getRemainingBudget } from "../systems/moveBudgetSystem";
import { carColor, carSprite } from "../systems/spawnSystem";
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
} from "../race/raceEngine";
import { sortCarsByProgress } from "../systems/orderingSystem";
import { validateTrack } from "../../validation/trackValidation";
import { PitModal, type PitStints } from "./ui/PitModal";
import type { HudCar, HudSnapshot } from "../../ui/hud";
import { DebugButtons } from "./ui/DebugButtons";
import { TextButton } from "./ui/TextButton";
import { applyCarsMovesVisibility } from "./ui/carsMovesVisibility";
import { drawTrack as drawTrackGraphics, laneColor } from "./rendering/trackRenderer";
import { spriteRotation } from "./rendering/heading";
import { registerRaceSceneInputHandlers } from "./input/registerRaceSceneInputHandlers";
import {
  appendBotDecisionEntry,
  buildBotDecisionSnapshot as buildBotDecisionSnapshotPayload,
  serializeBotTargets,
  serializeBotTrace,
  type BotDecisionLogEntry
} from "./debug/botDecisionDebug";
import { buildGameDebugSnapshot } from "./debug/gameDebugSnapshot";
import type { AppliedTurnSummary, BackendTurnAction, PublicLobby, TurnSource } from "../../net/backendApi";
import { toEngineRace } from "../../net/raceSync";

declare global {
  interface Window {
    __srp?: {
      state: () => ReturnType<typeof buildGameDebugSnapshot>;
      cellScreenPos: (cellId: string) => { x: number; y: number } | null;
      /** Where a car token is drawn right now (page coordinates), mid-tween included. */
      tokenScreenPos: (carId: number) => { x: number; y: number } | null;
      /** Stops the looping halo pulse so screenshots are deterministic. */
      freezeAnimations: () => void;
      status: () => {
        raceLaps: number;
        winnerCarId: number | null;
        canControl: boolean;
        activeOwnerId: string;
      };
    };
  }
}

type CellMap = Map<string, TrackCell>;


export class RaceScene extends Phaser.Scene {
  private static readonly MOVE_TWEEN_MS = 280;
  private static readonly UI = {
    padding: 10,
    bottomButtonYPad: 10
  };
  private static readonly HUD = {
    hoverMaxDist: 18
  };
  private static readonly BOT_LOG_LIMIT = 1000;
  private static readonly HUD_LABELS = {
    noneTags: "none",
    targetPrefix: "target:",
    factorsPrefix: "factors:",
    validTargetsPrefix: "valid targets:"
  };
  private track!: TrackData;
  private cellMap!: CellMap;
  private ctx!: RaceContext;
  // Rules and race state live in the engine; the scene only renders them.
  private race: RaceState = { cars: [], turn: { order: [], index: 0 }, raceLaps: 5, winnerCarId: null };

  private gTrack!: Phaser.GameObjects.Graphics;
  private trackImage?: Phaser.GameObjects.Image;
  private gTargets!: Phaser.GameObjects.Graphics;
  private gFrame!: Phaser.GameObjects.Graphics;
  private hoverCell: TrackCell | null = null;
  private logLines: string[] = [];
  private carNames = new Map<number, string>();
  private showForwardIndex = false;
  private forwardIndexLabels: Phaser.GameObjects.Text[] = [];
  private carTokens: Map<number, Phaser.GameObjects.Container> = new Map();
  private activeHalos: Map<number, Phaser.GameObjects.Ellipse> = new Map();
  private activeHaloTween: Phaser.Tweens.Tween | null = null;
  private validTargets: Map<string, TargetInfo> = new Map();
  private targetCostLabels: Phaser.GameObjects.Text[] = [];
  private dragOrigin: { x: number; y: number } | null = null;
  private pendingPit: { cell: TrackCell; origin: { x: number; y: number } } | null = null;
  private pitModal!: PitModal;
  private totalCars = 1;
  private humanCars = 1;
  private botCars = 0;
  // Multiplayer: after sending a turn, wait for the server's race.state before accepting input.
  private awaitingServerUntil = 0;
  private backendLobbyId: string | null = null;
  private localPlayerId: string | null = null;
  private botDecisionLog: BotDecisionLogEntry[] = [];
  private botDecisionSeq = 1;
  private skipButton!: TextButton;
  private debugButtons!: DebugButtons;
  private showCarsAndMoves = true;
  private get cars(): Car[] {
    return this.race.cars;
  }
  private get turn() {
    return this.race.turn;
  }
  private get raceLapTarget(): number {
    return this.race.raceLaps;
  }
  private get raceFinished(): boolean {
    return this.race.winnerCarId !== null;
  }
  private get winnerCarId(): number | null {
    return this.race.winnerCarId;
  }
  private get activeCar(): Car {
    const { cars, turn } = this.race;
    return (cars.find((c) => c.carId === turn.order[turn.index]) ?? cars[0]) as Car;
  }
  private readonly onExternalToggleCarsMoves = () => {
    this.showCarsAndMoves = !this.showCarsAndMoves;
    this.updateExternalToggleLabel();
    this.applyCarsAndMovesVisibility();
  };
  private readonly onBackendLobbyState = (event: Event) => {
    const custom = event as CustomEvent<{ lobby?: PublicLobby; localPlayerId?: string }>;
    const lobby = custom.detail?.lobby;
    if (!lobby) return;
    const localPlayerId =
      typeof custom.detail?.localPlayerId === "string" ? custom.detail.localPlayerId : null;
    this.applyBackendLobbyState(lobby, localPlayerId);
  };
  private readonly onBackendTurnApplied = (event: Event) => {
    const custom = event as CustomEvent<{
      lobbyId?: string;
      playerId?: string;
      applied?: AppliedTurnSummary;
      source?: TurnSource;
    }>;
    const detail = custom.detail;
    if (
      !detail ||
      typeof detail.lobbyId !== "string" ||
      typeof detail.playerId !== "string" ||
      !detail.applied
    ) {
      return;
    }
    this.applyBackendTurnApplied(detail.lobbyId, detail.playerId, detail.applied, detail.source);
  };
  private readonly buildInfo = {
    version: "debug-snapshot-v3",
    // eslint-disable-next-line no-undef
    gitSha: __GIT_SHA__
  };

  constructor() {
    super("RaceScene");
  }

  create() {
    const raw = this.cache.json.get("track");
    const parsed = trackSchema.safeParse(raw);

    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\\n");
      throw new Error(`Invalid track JSON:\\n${msg}`);
    }

    this.track = parsed.data as TrackData;
    const validationErrors = validateTrack(this.track);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid track data:\\n${validationErrors.map((e) => `- ${e}`).join("\\n")}`);
    }
    this.ctx = createRaceContext(this.track);
    this.cellMap = this.ctx.cellMap;
    this.totalCars = this.registry.get(REG_TOTAL_CARS);
    this.humanCars = this.registry.get(REG_HUMAN_CARS);
    this.botCars = this.registry.get(REG_BOT_CARS);

    const grassCenter = this.getTrackCenter() ?? { x: 0, y: 0 };
    this.add.tileSprite(grassCenter.x, grassCenter.y, 4000, 3000, "grass").setDepth(-10);
    this.gTrack = this.add.graphics();
    this.gTargets = this.add.graphics();
    this.gFrame = this.add.graphics();
    this.drawTrack();
    this.drawFrame();
    this.centerTrack();
    this.setUIFixed();
    this.scale.on("resize", () => {
      this.drawFrame();
      this.layoutUI();
      this.centerTrack();
    });
    this.initCars();
    this.initTurn();
    this.recomputeTargets();
    this.drawTargets();
    this.layoutUI();
    this.createPitModal();
    this.createSkipButton();
    this.createDebugButtons();
    this.emitHud();
    this.applyCarsAndMovesVisibility();
    this.updateExternalToggleLabel();
    this.setUIFixed();
    this.reactToRace(); // seeds the feel memory: nothing fires for the state we start in
    // game.destroy() emits DESTROY, not SHUTDOWN: without both, a dead scene keeps
    // reacting to lobby events (the next online race would hit its destroyed sprites).
    const removeWindowListeners = () => {
      window.removeEventListener("srp:toggle-cars-moves", this.onExternalToggleCarsMoves);
      window.removeEventListener("srp:backend-lobby-state", this.onBackendLobbyState);
      window.removeEventListener("srp:backend-turn-applied", this.onBackendTurnApplied);
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, removeWindowListeners);
    this.events.once(Phaser.Scenes.Events.DESTROY, removeWindowListeners);
    window.addEventListener("srp:toggle-cars-moves", this.onExternalToggleCarsMoves);
    window.addEventListener("srp:backend-lobby-state", this.onBackendLobbyState);
    window.addEventListener("srp:backend-turn-applied", this.onBackendTurnApplied);

    registerRaceSceneInputHandlers({
      scene: this,
      isRaceFinished: () => this.raceFinished,
      pitModal: this.pitModal,
      getActiveToken: () => this.getActiveToken(),
      getActiveCar: () => this.activeCar,
      getDragOrigin: () => this.dragOrigin,
      setDragOrigin: (origin) => {
        this.dragOrigin = origin;
      },
      cellMap: this.cellMap,
      getValidTargets: () => this.validTargets,
      activeHalos: this.activeHalos,
      findNearestCell: (x, y, maxDist) => this.findNearestCell(x, y, maxDist),
      recomputeTargets: () => this.recomputeTargets(),
      drawTargets: () => this.drawTargets(),
      setHoverCell: (cell) => this.setHoverCell(cell),
      copyCellId: (cellId) => {
        void this.copyCellId(cellId);
      },
      toggleForwardIndexOverlay: () => this.toggleForwardIndexOverlay(),
      openPitModal: (cell, origin) => this.openPitModal(cell, origin),
      onMove: (targetCellId) => {
        this.applyLocalAction({ type: "move", targetCellId });
      },
      canControlActiveCar: () => this.canLocalControlActiveCar(),
      onUnauthorizedControlAttempt: () => {
        this.addLog("Not your turn/car.");
      },
      hoverMaxDist: RaceScene.HUD.hoverMaxDist,
      dragSnapDist: 18
    });

    if (import.meta.env.DEV || import.meta.env.MODE === "test") {
      // e2e hook: read-only state + cell -> page coordinates for real mouse drags
      window.__srp = {
        state: () => this.buildDebugSnapshot(),
        status: () => ({
          raceLaps: this.raceLapTarget,
          winnerCarId: this.winnerCarId,
          canControl: this.canLocalControlActiveCar() && !this.raceFinished,
          activeOwnerId: this.activeCar.ownerId
        }),
        freezeAnimations: () => {
          this.activeHaloTween?.stop();
          this.activeHaloTween = null;
          for (const halo of this.activeHalos.values()) halo.setScale(1).setAlpha(1);
          this.confetti?.stop();
          this.confetti = null;
          this.animationsFrozen = true;
        },
        cellScreenPos: (cellId) => this.cellScreenPos(cellId),
        tokenScreenPos: (carId) => {
          const token = this.carTokens.get(carId);
          return token ? this.worldToScreen(token.x, token.y) : null;
        }
      };
    }
    // main.ts replays the latest lobby state now that the scene listens for it.
    window.dispatchEvent(new Event("srp:scene-ready"));
  }

  // Local seats: humans first, then bots.
  private buildSeats(): RaceSeat[] {
    const seats: RaceSeat[] = [
      ...Array.from({ length: this.humanCars }, (_, i) => ({ isBot: false, ownerId: `P${i + 1}` })),
      ...Array.from({ length: this.botCars }, (_, i) => ({
        isBot: true,
        ownerId: `BOT${i + 1}`,
        botLevel: (this.registry.get(REG_BOT_LEVEL) as BotLevel | undefined) ?? "normal"
      }))
    ];
    return seats.length > 0 ? seats : [{ isBot: false, ownerId: "P1" }];
  }

  private startRace(raceLaps: number) {
    this.race = createRace(this.ctx, this.buildSeats(), raceLaps);
    this.race.cars.forEach((car, i) => this.spawnCarToken(car, carSprite(i)));
  }

  private initCars() {
    this.startRace(this.registry.get(REG_RACE_LAPS));
  }

  private clearCarVisuals() {
    for (const token of this.carTokens.values()) {
      token.destroy();
    }
    this.carTokens.clear();
    for (const halo of this.activeHalos.values()) {
      halo.destroy();
    }
    this.activeHalos.clear();
  }

  private respawnCarsForComposition(totalCars: number, humanCars: number, botCars: number) {
    this.totalCars = Math.max(1, Math.min(11, Math.trunc(totalCars)));
    this.humanCars = Math.max(0, Math.min(this.totalCars, Math.trunc(humanCars)));
    this.botCars = Math.max(0, Math.min(this.totalCars - this.humanCars, Math.trunc(botCars)));
    this.clearCarVisuals();
    this.startRace(this.race.raceLaps);
    this.validTargets = new Map();
    this.updateActiveCarVisuals();
    this.updateSkipButtonState();
    this.drawTargets();
    this.emitHud();
  }

  private isBackendAuthoritativeMode(): boolean {
    return this.backendLobbyId != null;
  }

  private canLocalControlActiveCar(): boolean {
    if (!this.isBackendAuthoritativeMode()) return true;
    if (!this.localPlayerId) return false;
    if (Date.now() < this.awaitingServerUntil) return false;
    return this.activeCar.ownerId === this.localPlayerId;
  }

  // Locks input until the server answers; unlocks by itself if it never does.
  private awaitServer() {
    const waitMs = 5000;
    this.awaitingServerUntil = Date.now() + waitMs;
    this.time.delayedCall(waitMs, () => {
      if (this.awaitingServerUntil === 0 || Date.now() < this.awaitingServerUntil) return;
      this.awaitingServerUntil = 0;
      this.refreshAfterTurn();
    });
  }

  // Multiplayer: the server owns the race. Replace our state with its snapshot and redraw.
  private applyBackendLobbyState(lobby: PublicLobby, localPlayerId: string | null) {
    this.backendLobbyId = lobby.lobbyId;
    this.localPlayerId = localPlayerId;
    this.awaitingServerUntil = 0;
    if (
      lobby.settings.totalCars !== this.totalCars ||
      lobby.settings.humanCars !== this.humanCars ||
      lobby.settings.botCars !== this.botCars
    ) {
      this.respawnCarsForComposition(
        lobby.settings.totalCars,
        lobby.settings.humanCars,
        lobby.settings.botCars
      );
    }
    const raceState = lobby.raceState;
    if (!raceState || (lobby.status !== "IN_RACE" && lobby.status !== "FINISHED")) return;

    const wasFinished = this.raceFinished;
    this.race = toEngineRace(raceState);
    if (!this.feelSeededOnline) {
      // the first server state is where we join or rejoin: it seeds, it must not celebrate
      this.feelSeededOnline = true;
      this.feel = createFeelMemory();
    }
    this.carNames = new Map(raceState.cars.map((car) => [car.carId, car.name]));
    if (this.carTokens.size !== this.cars.length) {
      this.clearCarVisuals();
      this.cars.forEach((car, i) => this.spawnCarToken(car, carSprite(i)));
    }
    if (this.raceFinished && !wasFinished) {
      const winner = this.cars.find((car) => car.carId === this.winnerCarId);
      this.addLog(
        `Race finished. Car ${this.winnerCarId} wins (${winner?.lapCount ?? 0}/${this.raceLapTarget} laps).`
      );
    }
    this.refreshAfterTurn();
  }

  // Remote and own turns alike arrive as events; the board itself redraws from race.state.
  private applyBackendTurnApplied(
    lobbyId: string,
    playerId: string,
    action: AppliedTurnSummary,
    source?: TurnSource
  ) {
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

  private spawnCarToken(car: Car, spriteKey: string) {
    const cell = this.cellMap.get(car.cellId);
    if (!cell) return;
    const halo = this.add.ellipse(cell.pos.x, cell.pos.y, 40, 26);
    halo.setStrokeStyle(3, 0xfff27a, 0.95);
    halo.setFillStyle(0xfff27a, 0.08);
    halo.setVisible(false);
    halo.setDepth(60);
    this.activeHalos.set(car.carId, halo);

    // Kenney cars point up; the sprite alone is rotated so the badge stays upright.
    const body = this.add.image(0, 0, spriteKey).setDisplaySize(15, 28);
    body.setRotation(spriteRotation(cell, this.cellMap));
    const badge = this.add.circle(0, 0, 5.5, 0x0b0f14, 0.85);
    const label = this.add.text(0, 0, String(car.carId), {
      fontFamily: "monospace",
      fontSize: "9px",
      color: "#ffffff"
    });
    label.setOrigin(0.5, 0.5);

    const token = this.add.container(cell.pos.x, cell.pos.y, [body, badge, label]);
    token.setDepth(50);
    token.setSize(28, 18);
    token.setInteractive({ useHandCursor: true });
    this.carTokens.set(car.carId, token);
  }

  private initTurn() {
    this.addLog(`Car ${this.activeCar.carId} to play.`);
    this.updateActiveCarVisuals();
    this.processBotsUntilHuman();
  }

  // Applies the active car's action through the engine. The engine rejects anything
  // invalid and leaves the state untouched; either way the scene re-renders from it.
  private applyLocalAction(action: RaceAction): boolean {
    if (this.isBackendAuthoritativeMode()) {
      // Multiplayer: the server validates and applies it; its race.state redraws the board.
      this.awaitServer();
      this.emitLocalTurnAction(action);
      this.faceDroppedCell(action);
      this.refreshAfterTurn();
      return true;
    }
    const result = applyAction(this.ctx, this.race, action);
    if (!result.ok) {
      this.addLog(`Action rejected (${result.reason}).`);
      this.refreshAfterTurn();
      return false;
    }
    for (const line of result.log) this.addLog(line);
    this.refreshAfterTurn();
    return true;
  }

  private raceFinishedAnnounced = false;
  private feel = createFeelMemory();
  private feelSeededOnline = false;
  private confetti: Confetti | null = null;
  // Set by the e2e hook: no celebration may run over a screenshot.
  private animationsFrozen = false;

  private refreshAfterTurn() {
    this.processBotsUntilHuman();
    this.syncTokens();
    this.updateActiveCarVisuals();
    this.recomputeTargets();
    this.drawTargets();
    this.updateSkipButtonState();
    this.emitHud();
    this.reactToRace();
    if (this.raceFinished && !this.raceFinishedAnnounced) {
      this.raceFinishedAnnounced = true;
      window.dispatchEvent(
        new CustomEvent("srp:race-finished", { detail: { winnerCarId: this.winnerCarId } })
      );
    }
  }

  // Toasts, confetti and sounds for what changed since the last render (nothing on the first one).
  private reactToRace() {
    const events = detectFeel(this.feel, {
      myCarId: this.localCar()?.carId ?? null,
      raceLaps: this.raceLapTarget,
      finished: this.raceFinished,
      canControl: this.localCanControl(),
      cars: this.cars.map((car) => ({
        carId: car.carId,
        lapCount: car.lapCount ?? 0,
        cellId: car.cellId,
        tire: car.tire,
        fuel: car.fuel
      }))
    });
    const loud = events.some((e) => e.type !== "move");
    for (const event of events) {
      if (event.type === "move" && loud) continue;
      this.reactTo(event);
    }
  }

  private reactTo(event: FeelEvent) {
    switch (event.type) {
      case "lap": {
        const text = event.final ? "Final lap" : `Lap ${event.completed} / ${event.laps} done`;
        window.dispatchEvent(new CustomEvent("srp:toast", { detail: { text, kind: event.final ? "final" : "lap" } }));
        play("lap");
        break;
      }
      case "finish":
        if (!this.animationsFrozen) this.confetti = new Confetti(this);
        play("finish");
        break;
      default:
        play(event.type);
    }
  }

  // Online, the server moves the car: until it answers, the car we just dropped keeps the
  // place and heading of its target cell instead of sliding back to the old one.
  private faceDroppedCell(action: RaceAction) {
    if (action.type === "skip") return;
    const cell = this.cellMap.get(action.targetCellId);
    const token = this.carTokens.get(this.activeCar.carId);
    if (!cell || !token) return;
    (token.first as Phaser.GameObjects.Image).setRotation(spriteRotation(cell, this.cellMap));
  }

  private syncTokens() {
    const awaitingServer = Date.now() < this.awaitingServerUntil;
    for (const car of this.cars) {
      const cell = this.cellMap.get(car.cellId);
      if (!cell) continue;
      const token = this.carTokens.get(car.carId);
      if (!token) continue;
      if (awaitingServer && car.carId === this.activeCar.carId) continue;
      const body = token.first as Phaser.GameObjects.Image;
      body.setRotation(spriteRotation(cell, this.cellMap));
      const halo = this.activeHalos.get(car.carId);
      if (token.x === cell.pos.x && token.y === cell.pos.y) continue;
      // slide to the new cell (already there after a drag-drop, so only bots and remote turns animate)
      this.tweens.killTweensOf([token, halo].filter(Boolean));
      this.tweens.add({
        targets: [token, halo].filter(Boolean),
        x: cell.pos.x,
        y: cell.pos.y,
        duration: RaceScene.MOVE_TWEEN_MS,
        ease: "Sine.easeInOut"
      });
    }
  }

  private processBotsUntilHuman() {
    if (this.raceFinished) return;
    if (this.isBackendAuthoritativeMode()) return;
    const maxBots = Math.max(1, this.cars.length);
    let steps = 0;
    while (this.activeCar.isBot && steps < maxBots && !this.raceFinished) {
      if (!this.playBotTurn()) break;
      steps += 1;
    }
    // Whoever is active now (human or bot) must be rendered as such, also when this
    // ran from recomputeTargets() after the turn-end refresh.
    if (steps > 0) {
      this.syncTokens();
      this.updateActiveCarVisuals();
    }
  }

  private playBotTurn(): boolean {
    const car = this.activeCar;
    const turnIndex = this.turn.index;
    const decision = decideBotAction(this.ctx, this.race);
    const result = applyAction(this.ctx, this.race, decision.action);
    if (!result.ok) {
      this.addLog(`Bot action rejected (${result.reason}).`);
      return false;
    }
    const action = decision.action;
    this.botDecisionSeq = appendBotDecisionEntry(
      this.botDecisionLog,
      RaceScene.BOT_LOG_LIMIT,
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

  private updateActiveCarVisuals() {
    if (this.activeHaloTween) {
      this.activeHaloTween.stop();
      this.activeHaloTween = null;
    }

    if (!this.showCarsAndMoves) {
      for (const token of this.carTokens.values()) {
        token.setVisible(false);
        this.input.setDraggable(token, false);
      }
      for (const halo of this.activeHalos.values()) {
        halo.setVisible(false);
      }
      return;
    }

    for (const [carId, token] of this.carTokens.entries()) {
      token.setVisible(true);
      const halo = this.activeHalos.get(carId);
      if (carId === this.activeCar.carId) {
        const canControlActive = this.canLocalControlActiveCar() && !this.raceFinished;
        token.setAlpha(1);
        token.setScale(canControlActive ? 1.1 : 1);
        this.input.setDraggable(token, canControlActive);
        if (halo) {
          halo.setPosition(token.x, token.y);
          halo.setVisible(canControlActive);
          halo.setScale(1);
          halo.setAlpha(1);
        }
      } else {
        token.setAlpha(0.6);
        token.setScale(1);
        this.input.setDraggable(token, false);
        if (halo) {
          halo.setVisible(false);
          halo.setScale(1);
          halo.setAlpha(1);
        }
      }
    }

    const activeHalo = this.activeHalos.get(this.activeCar.carId);
    if (activeHalo && this.canLocalControlActiveCar() && !this.raceFinished) {
      this.activeHaloTween = this.tweens.add({
        targets: activeHalo,
        scaleX: { from: 1, to: 1.12 },
        scaleY: { from: 1, to: 1.12 },
        alpha: { from: 1, to: 0.6 },
        duration: 520,
        yoyo: true,
        repeat: -1,
        ease: "Sine.easeInOut"
      });
    }
  }

  private recomputeTargets() {
    if (this.raceFinished) {
      this.validTargets = new Map();
      this.updateSkipButtonState();
      return;
    }
    if (this.isBackendAuthoritativeMode() && !this.canLocalControlActiveCar()) {
      this.validTargets = new Map();
      this.updateSkipButtonState();
      return;
    }
    if (this.activeCar.isBot) {
      this.processBotsUntilHuman();
      if (this.activeCar.isBot) {
        return;
      }
    }
    this.validTargets = this.computeTargetsForCar(this.activeCar);
    this.updateSkipButtonState();
  }

  private computeTargetsForCar(car: Car): Map<string, TargetInfo> {
    return computeTargets(this.ctx, this.race, car);
  }

  private drawTargets() {
    this.gTargets.clear();
    this.clearTargetCostLabels();
    if (!this.showCarsAndMoves) return;
    for (const [cellId, info] of this.validTargets) {
      const cell = this.cellMap.get(cellId);
      if (!cell) continue;

      const color = info.isPitTrigger ? 0xffe066 : laneColor(cell.laneIndex);
      this.gTargets.fillStyle(color, 0.4);
      this.gTargets.fillCircle(cell.pos.x, cell.pos.y, 10);
      this.gTargets.lineStyle(2, color, 0.95);
      this.gTargets.strokeCircle(cell.pos.x, cell.pos.y, 10);
      // Risk: the move leaves a resource under 20% (thin ring) or empty (thick ring).
      const left = this.resourcesAfter(info);
      if (!info.isPitTrigger && Math.min(left.tire, left.fuel) < 20) {
        this.gTargets.lineStyle(Math.min(left.tire, left.fuel) <= 0 ? 4 : 2, 0xff4d4d, 1);
        this.gTargets.strokeCircle(cell.pos.x, cell.pos.y, 14);
      }

      const costLabel = this.add.text(
        cell.pos.x,
        cell.pos.y,
        this.formatTargetCost(info, cell.laneIndex),
        {
          fontFamily: "monospace",
          fontSize: "11px",
          color: "#ffffff",
          fontStyle: "bold",
          stroke: "#0b0f14",
          strokeThickness: 3
        }
      );
      costLabel.setOrigin(0.5, 0.5);
      costLabel.setDepth(46);
      this.targetCostLabels.push(costLabel);
    }
  }

  private resourcesAfter(info: TargetInfo) {
    return {
      tire: Math.max(0, this.activeCar.tire - info.tireCost),
      fuel: Math.max(0, this.activeCar.fuel - info.fuelCost)
    };
  }

  private clearTargetCostLabels() {
    for (const label of this.targetCostLabels) {
      label.destroy();
    }
    this.targetCostLabels = [];
  }

  private formatTargetCost(info: TargetInfo, targetLaneIndex: number): string {
    const fromLaneIndex = this.cellMap.get(this.activeCar.cellId)?.laneIndex ?? targetLaneIndex;
    const moveSpend =
      info.moveSpend ?? computeMoveSpend(info.distance, fromLaneIndex, targetLaneIndex);
    return String(moveSpend);
  }

  private drawFrame() {
    this.gFrame.clear();
    this.gFrame.lineStyle(1, 0x2a3642, 0.8);
    this.gFrame.strokeRect(1, 1, this.scale.width - 2, this.scale.height - 2);
  }

  private setUIFixed() {
    const fixed = [this.gFrame, this.skipButton].filter(Boolean);
    for (const obj of fixed) {
      if (
        typeof (obj as { setScrollFactor?: (x: number, y?: number) => unknown }).setScrollFactor ===
        "function"
      ) {
        (obj as unknown as { setScrollFactor: (x: number, y?: number) => unknown }).setScrollFactor(
          0
        );
      }
    }
    if (this.pitModal) {
      this.pitModal.setFixed();
    }
    if (this.skipButton) this.skipButton.setFixed();
    if (this.debugButtons) this.debugButtons.setFixed();
  }

  // Fit the track between the HUD columns (read from the DOM) and above the bottom buttons.
  private centerTrack() {
    const xs = this.track.cells.map((c) => c.pos.x);
    const ys = this.track.cells.map((c) => c.pos.y);
    if (xs.length === 0 || ys.length === 0) return;
    const pad = 20; // curbs
    const [minX, maxX] = [Math.min(...xs) - pad, Math.max(...xs) + pad];
    const [minY, maxY] = [Math.min(...ys) - pad, Math.max(...ys) + pad];
    const w = this.scale.width;
    const h = this.scale.height;
    const edge = (sel: string, side: "left" | "right") => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r && r.width > 0 ? (side === "left" ? r.right + 10 : w - r.left + 10) : 0;
    };
    const gl = edge(".hud-left", "left");
    const gr = edge(".hud-right", "right");
    const bottom = 50;
    const zoom = Phaser.Math.Clamp(Math.min((w - gl - gr) / (maxX - minX), (h - bottom) / (maxY - minY)), 0.4, 1);
    const cam = this.cameras.main;
    cam.setZoom(zoom);
    cam.centerOn((minX + maxX) / 2 - (gl - gr) / 2 / zoom, (minY + maxY) / 2 + bottom / 2 / zoom);
    this.layoutUI();
  }

  private getTrackCenter(): { x: number; y: number } | null {
    const xs = this.track.cells.map((c) => c.pos.x);
    const ys = this.track.cells.map((c) => c.pos.y);
    if (xs.length === 0 || ys.length === 0) return null;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  private addLog(line: string) {
    this.logLines.push(line);
    if (this.logLines.length > 30) this.logLines.shift();
    this.emitHud();
  }

  private toggleForwardIndexOverlay() {
    this.showForwardIndex = !this.showForwardIndex;
    this.renderForwardIndexOverlay();
    this.emitHud();
  }

  private renderForwardIndexOverlay() {
    for (const label of this.forwardIndexLabels) {
      label.destroy();
    }
    this.forwardIndexLabels = [];
    if (!this.showForwardIndex) return;
    for (const cell of this.track.cells) {
      const label = this.add.text(cell.pos.x + 8, cell.pos.y + 6, String(cell.forwardIndex), {
        fontFamily: "monospace",
        fontSize: "10px",
        color: "#e6edf3"
      });
      label.setDepth(20);
      this.forwardIndexLabels.push(label);
    }
  }

  private layoutUI() {
    const w = this.scale.width;
    const h = this.scale.height;
    const ui = RaceScene.UI;
    if (this.skipButton) {
      this.skipButton.setPosition(w / 2, h - ui.bottomButtonYPad);
    }
    if (this.debugButtons) {
      this.debugButtons.layout(w, h, ui.padding, ui.bottomButtonYPad);
    }
    // Fixed (scrollFactor 0) objects are zoomed with the camera; undo that so the UI keeps its size.
    const z = this.cameras.main.zoom;
    const k = 1 / z;
    const texts = [this.skipButton?.getText(), ...(this.debugButtons?.getTexts() ?? [])];
    for (const t of texts) {
      if (t) t.setScale(k).setPosition(w / 2 + (t.x - w / 2) * k, h / 2 + (t.y - h / 2) * k);
    }
    const origin = { x: (w / 2) * (1 - k), y: (h / 2) * (1 - k) };
    this.gFrame?.setScale(k).setPosition(origin.x, origin.y);
    this.pitModal?.getContainer().setScale(k).setPosition(origin.x, origin.y);
  }

  private createPitModal() {
    this.pitModal = new PitModal(this);
  }

  private createSkipButton() {
    this.skipButton = new TextButton(this, "Skip turn", {
      fontSize: "14px",
      originX: 0.5,
      originY: 1,
      onClick: () => this.skipTurn()
    });
    this.updateSkipButtonState();
    this.layoutUI();
    this.setUIFixed();
  }

  private createDebugButtons() {
    this.debugButtons = new DebugButtons(this, {
      onCopyDebug: () => this.copyDebugSnapshot(),
      onCopyBotDebug: () => this.copyBotDecisionSnapshot(),
      onCopyBotDebugShort: () => this.copyShortBotDecisionSnapshot()
    });
    this.layoutUI();
    this.setUIFixed();
  }

  private updateExternalToggleLabel() {
    const button = document.getElementById("toggleCarsMovesBtn") as HTMLButtonElement | null;
    if (!button) return;
    button.textContent = this.showCarsAndMoves ? "Cars+moves: ON" : "Cars+moves: OFF";
  }

  private applyCarsAndMovesVisibility() {
    applyCarsMovesVisibility({
      showCarsAndMoves: this.showCarsAndMoves,
      activeHaloTween: this.activeHaloTween,
      setActiveHaloTween: (tween) => {
        this.activeHaloTween = tween;
      },
      gTargets: this.gTargets,
      clearTargetCostLabels: () => this.clearTargetCostLabels(),
      carTokens: this.carTokens,
      activeHalos: this.activeHalos,
      setDraggable: (token, isDraggable) => this.input.setDraggable(token, isDraggable),
      updateActiveCarVisuals: () => this.updateActiveCarVisuals(),
      drawTargets: () => this.drawTargets()
    });
  }

  private updateSkipButtonState() {
    if (!this.skipButton) return;
    const canSkip =
      !this.raceFinished &&
      this.validTargets.size === 0 &&
      this.activeCar.state === "ACTIVE" &&
      this.canLocalControlActiveCar();
    this.skipButton.setAlpha(canSkip ? 1 : 0.4);
    this.skipButton.setInteractive(canSkip);
  }

  private buildDebugSnapshot() {
    return buildGameDebugSnapshot({
      buildInfo: this.buildInfo,
      track: this.track,
      cellMap: this.cellMap,
      cars: this.cars,
      activeCar: this.activeCar,
      validTargets: this.validTargets,
      botDecisionCount: this.botDecisionLog.length,
      moveBudget: MOVE_BUDGET,
      moveRates: MOVE_RATES,
      disallowPitBoxTargets: this.activeCar.pitServiced
    });
  }

  private buildBotDecisionSnapshot(shortMode = false) {
    return buildBotDecisionSnapshotPayload(
      this.buildInfo,
      this.track.trackId,
      this.botDecisionLog,
      shortMode
    );
  }

  private async copyDebugSnapshot() {
    const snapshot = this.buildDebugSnapshot();
    const payload = JSON.stringify(snapshot, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      this.addLog("Copied debug snapshot to clipboard.");
    } catch {
      this.addLog("Clipboard failed. Check console for snapshot.");
      console.log("Debug snapshot:", payload);
    }
  }

  private async copyBotDecisionSnapshot() {
    const snapshot = this.buildBotDecisionSnapshot();
    const payload = JSON.stringify(snapshot, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      this.addLog("Copied bot decision snapshot to clipboard.");
    } catch {
      this.addLog("Clipboard failed. Check console for bot snapshot.");
      console.log("Bot decision snapshot:", payload);
    }
  }

  private async copyShortBotDecisionSnapshot() {
    const snapshot = this.buildBotDecisionSnapshot(true);
    const payload = JSON.stringify(snapshot, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      this.addLog("Copied short bot decision snapshot to clipboard.");
    } catch {
      this.addLog("Clipboard failed. Check console for short bot snapshot.");
      console.log("Short bot decision snapshot:", payload);
    }
  }

  private async copyCellId(cellId: string) {
    try {
      await navigator.clipboard.writeText(cellId);
      this.addLog(`Copied cell id: ${cellId}`);
    } catch {
      this.addLog(`Clipboard failed for cell id: ${cellId}`);
      console.log("Cell id:", cellId);
    }
  }

  private skipTurn() {
    if (this.raceFinished) return;
    if (!this.canLocalControlActiveCar()) {
      this.addLog("Not your turn/car.");
      return;
    }
    if (this.validTargets.size !== 0 || this.activeCar.state !== "ACTIVE") return;
    this.applyLocalAction({ type: "skip" });
  }

  private openPitModal(cell: TrackCell, origin: { x: number; y: number }) {
    this.pendingPit = { cell, origin };
    const token = this.getActiveToken();
    if (token) token.disableInteractive();
    this.pitModal.open({
      setup: this.activeCar.setup,
      stints: (setup) => this.pitStints(setup),
      bodyLines: [
        `Drop on PIT_BOX: ${cell.id}`,
        `Setup will be applied.`,
        `Tires and fuel refilled to 100.`,
        `Pit penalty: lose 1 turn.`
      ],
      onConfirm: (setup) => {
        if (!this.pendingPit) return;
        const targetCellId = this.pendingPit.cell.id;
        this.closePitModal();
        this.applyLocalAction({ type: "pit", targetCellId, setup });
      },
      onCancel: () => {
        if (!this.pendingPit) return;
        const token = this.getActiveToken();
        if (token) token.setPosition(this.pendingPit.origin.x, this.pendingPit.origin.y);
        this.closePitModal();
        this.recomputeTargets();
        this.drawTargets();
      }
    });
  }

  // Stint after the refill (100% tire and fuel) for each compound at the wings and psi being set.
  private pitStints(setup: Car["setup"]): PitStints {
    const spineLen = this.ctx.trackIndex.spineLen;
    const at = (compound: "soft" | "hard") => stintEstimate({ tire: 100, fuel: 100, setup: { ...setup, compound } }, spineLen);
    return { soft: at("soft"), hard: at("hard") };
  }

  private closePitModal() {
    this.pendingPit = null;
    this.pitModal.close();
    const token = this.getActiveToken();
    if (token) token.setInteractive({ useHandCursor: true });
  }

  private emitLocalTurnAction(action: BackendTurnAction) {
    window.dispatchEvent(
      new CustomEvent<BackendTurnAction>("srp:local-turn-action", { detail: action })
    );
  }

  private getActiveToken(): Phaser.GameObjects.Container | null {
    return this.carTokens.get(this.activeCar.carId) ?? null;
  }

  private drawTrack() {
    drawTrackGraphics({
      graphics: this.gTrack,
      track: this.track,
      cellMap: this.cellMap,
      showForwardIndex: this.showForwardIndex,
      renderForwardIndexOverlay: () => this.renderForwardIndexOverlay()
    });
    // Bake into a texture: a Graphics object is re-tessellated every frame, the static track is not worth that.
    const key = "track-baked";
    this.trackImage?.destroy();
    if (this.textures.exists(key)) this.textures.remove(key);
    const xs = this.track.cells.map((c) => c.pos.x);
    const ys = this.track.cells.map((c) => c.pos.y);
    const w = Math.ceil(Math.max(...xs) + 100);
    const h = Math.ceil(Math.max(...ys) + 100);
    this.gTrack.generateTexture(key, w, h);
    this.gTrack.clear();
    this.trackImage = this.add.image(0, 0, key).setOrigin(0, 0).setDepth(-5);
  }

  private findNearestCell(x: number, y: number, maxDist: number): TrackCell | null {
    let best: TrackCell | null = null;
    let bestD2 = maxDist * maxDist;

    for (const c of this.track.cells) {
      const dx = c.pos.x - x;
      const dy = c.pos.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = c;
      }
    }
    return best;
  }

  private makeHudText(cell: TrackCell | null): string {
    if (!cell) {
      const activeStatus = [
        `Active: Car ${this.activeCar.carId}`,
        `Lap: ${this.activeCar.lapCount ?? 0}/${this.raceLapTarget}`,
        `Tire: ${this.activeCar.tire}%`,
        `Fuel: ${this.activeCar.fuel}%`
      ].join("\n");
      return [
        activeStatus,
        `${RaceScene.HUD_LABELS.validTargetsPrefix} ${this.validTargets.size}`
      ].join("\n");
    }

    const tags = (cell.tags ?? []).join(", ") || RaceScene.HUD_LABELS.noneTags;
    const targetInfo = this.validTargets.get(cell.id);
    const factors = targetInfo ? this.computeCostFactors(cell.laneIndex) : null;
    const targetLine = targetInfo
      ? `${RaceScene.HUD_LABELS.targetPrefix} d${targetInfo.distance}  tire-${targetInfo.tireCost}  fuel-${targetInfo.fuelCost}${targetInfo.isPitTrigger ? "  PIT" : ""}`
      : null;
    const factorLine = factors
      ? `${RaceScene.HUD_LABELS.factorsPrefix} aero x${factors.aero.toFixed(2)}  psi x${factors.psi.toFixed(2)}  laneT x${factors.laneT.toFixed(2)}  laneF x${factors.laneF.toFixed(2)}`
      : null;
    return [
      `cell: ${cell.id}`,
      `zone: ${cell.zoneIndex}  lane: ${cell.laneIndex}`,
      `lap: ${this.activeCar.lapCount ?? 0}  fwd: ${cell.forwardIndex}`,
      `tags: ${tags}`,
      `next: ${cell.next.length}`,
      ...(targetLine ? [targetLine] : []),
      ...(factorLine ? [factorLine] : []),
      `${RaceScene.HUD_LABELS.validTargetsPrefix} ${this.validTargets.size}`
    ].join("\n");
  }

  // Page coordinates of a cell, for the e2e hook and the DOM tooltip.
  private cellScreenPos(cellId: string): { x: number; y: number } | null {
    const cell = this.cellMap.get(cellId);
    return cell ? this.worldToScreen(cell.pos.x, cell.pos.y) : null;
  }

  private worldToScreen(wx: number, wy: number): { x: number; y: number } {
    const cam = this.cameras.main;
    const rect = this.game.canvas.getBoundingClientRect();
    const sx = rect.width / this.scale.width;
    const sy = rect.height / this.scale.height;
    return {
      x: rect.left + (wx - cam.worldView.x) * cam.zoom * sx,
      y: rect.top + (wy - cam.worldView.y) * cam.zoom * sy
    };
  }

  private setHoverCell(cell: TrackCell | null) {
    if (cell?.id === this.hoverCell?.id) return;
    this.hoverCell = cell;
    this.emitHud();
  }

  private hudCar(car: Car): HudCar {
    const index = this.cars.indexOf(car);
    const solo = !this.isBackendAuthoritativeMode();
    return {
      carId: car.carId,
      name: this.carNames.get(car.carId) ?? (solo && !car.isBot ? "You" : `Car ${car.carId}`),
      color: carColor(index),
      isBot: car.isBot,
      lap: car.lapCount ?? 0,
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

  private plan(): BotPlanContext {
    return buildPlanContext(this.ctx.trackIndex, this.raceLapTarget);
  }

  // The local player's car (online: their seat; solo: the first human).
  private localCar(): Car | undefined {
    return this.isBackendAuthoritativeMode()
      ? this.cars.find((car) => car.ownerId === this.localPlayerId)
      : this.cars.find((car) => !car.isBot);
  }

  private localCanControl(): boolean {
    return !this.raceFinished && this.canLocalControlActiveCar() && !this.activeCar.isBot;
  }

  // One plain snapshot for the DOM HUD (src/ui/hud.ts); sent after every change it shows.
  private emitHud() {
    if (this.cars.length === 0) return;
    const mine = this.localCar();
    const ordered = sortCarsByProgress(this.cars, this.cellMap, {
      turnOrder: this.turn.order,
      turnIndex: this.turn.index
    });
    const target = this.hoverCell ? this.validTargets.get(this.hoverCell.id) : undefined;
    const pos = this.hoverCell && target && this.showCarsAndMoves ? this.cellScreenPos(this.hoverCell.id) : null;
    const snapshot: HudSnapshot = {
      raceLaps: this.raceLapTarget,
      finished: this.raceFinished,
      winnerCarId: this.winnerCarId,
      myCarId: mine?.carId ?? null,
      activeCarId: this.activeCar.carId,
      canControl: this.localCanControl(),
      cars: ordered.map((car) => this.hudCar(car)),
      hover:
        pos && target && this.hoverCell
          ? {
              ...pos,
              distance: target.distance,
              moveSpend: Number(this.formatTargetCost(target, this.hoverCell.laneIndex)),
              tireCost: target.tireCost,
              fuelCost: target.fuelCost,
              isPit: target.isPitTrigger,
              tireBefore: this.activeCar.tire,
              fuelBefore: this.activeCar.fuel
            }
          : null,
      debugText: this.showForwardIndex ? this.makeHudText(this.hoverCell) : null,
      log: [...this.logLines]
    };
    window.dispatchEvent(new CustomEvent("srp:hud", { detail: snapshot }));
  }

  private computeCostFactors(laneIndex: number) {
    const { aeroFactor, psiFactor } = setupFactors(this.activeCar.setup);
    const lane = laneWearFactors(laneIndex);
    return { aero: aeroFactor, psi: psiFactor, laneT: lane.tire, laneF: lane.fuel };
  }
}
