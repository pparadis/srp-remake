import Phaser from "phaser";
import type { TrackData, TrackCell } from "../types/track";
import type { Car } from "../types/car";
import { trackSchema } from "../../validation/trackSchema";
import {
  INNER_MAIN_LANE,
  MOVE_BUDGET,
  MOVE_RATES,
  OUTER_MAIN_LANE,
  REG_BOT_CARS,
  REG_HUMAN_CARS,
  REG_RACE_LAPS,
  REG_TOTAL_CARS
} from "../constants";
import type { TargetInfo } from "../systems/movementSystem";
import { computeMoveSpend, getRemainingBudget } from "../systems/moveBudgetSystem";
import { carSprite } from "../systems/spawnSystem";
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
import { PitModal } from "./ui/PitModal";
import { LogPanel } from "./ui/LogPanel";
import { StandingsPanel } from "./ui/StandingsPanel";
import { DebugButtons } from "./ui/DebugButtons";
import { TextButton } from "./ui/TextButton";
import { applyCarsMovesVisibility } from "./ui/carsMovesVisibility";
import { drawTrack as drawTrackGraphics, headingOf, laneColor } from "./rendering/trackRenderer";
import { registerRaceSceneInputHandlers } from "./input/registerRaceSceneInputHandlers";
import {
  appendBotDecisionEntry,
  buildBotDecisionSnapshot as buildBotDecisionSnapshotPayload,
  serializeBotTargets,
  serializeBotTrace,
  type BotDecisionLogEntry
} from "./debug/botDecisionDebug";
import { buildGameDebugSnapshot } from "./debug/gameDebugSnapshot";
import type { AppliedTurnSummary, BackendTurnAction, PublicLobby } from "../../net/backendApi";
import { toEngineRace } from "../../net/raceSync";

declare global {
  interface Window {
    __srp?: {
      state: () => ReturnType<typeof buildGameDebugSnapshot>;
      cellScreenPos: (cellId: string) => { x: number; y: number } | null;
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
    logPanel: { width: 290, height: 180, radius: 8 },
    standingsPanel: { width: 250, minHeight: 64, radius: 8 },
    logPadding: 10,
    standingsHeaderOffset: { x: 8, y: 6 },
    standingsTextOffset: { x: 8, y: 26 },
    standingsModeOffsetX: 120,
    bottomButtonYPad: 10
  };
  private static readonly HUD = {
    hoverMaxDist: 18,
    infoPos: { x: 14, y: 14 },
    debugHintPos: { x: 14, y: 36 },
    cyclePosY: 10
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
  private txtInfo!: Phaser.GameObjects.Text;
  private txtCycle!: Phaser.GameObjects.Text;
  private txtDebugHint!: Phaser.GameObjects.Text;
  private centerResourceBg!: Phaser.GameObjects.Rectangle;
  private txtCenterTire!: Phaser.GameObjects.Text;
  private txtCenterFuel!: Phaser.GameObjects.Text;
  private logPanel!: LogPanel;
  private standingsPanel!: StandingsPanel;
  private showForwardIndex = false;
  private forwardIndexLabels: Phaser.GameObjects.Text[] = [];
  private uiLogRect = { x: 0, y: 0, w: 0, h: 0 };
  private uiStandingsRect = { x: 0, y: 0, w: 0, h: 0 };
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
    this.applyBackendTurnApplied(detail.lobbyId, detail.playerId, detail.applied);
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
    this.txtInfo = this.add.text(RaceScene.HUD.infoPos.x, RaceScene.HUD.infoPos.y, "", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#c7d1db"
    });
    this.txtDebugHint = this.add.text(
      RaceScene.HUD.debugHintPos.x,
      RaceScene.HUD.debugHintPos.y,
      "Debug: F = forwardIndex overlay, C = cars+moves",
      {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#9fb0bf"
      }
    );
    this.txtCycle = this.add.text(0, RaceScene.HUD.cyclePosY, "", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#c7d1db"
    });
    this.txtCycle.setOrigin(0.5, 0);
    this.logPanel = new LogPanel(this);
    this.standingsPanel = new StandingsPanel(this, {
      onToggle: () => {
        this.layoutUI();
        this.updateStandings();
      },
      onModeChange: () => {
        this.updateStandings();
      }
    });

    this.drawTrack();
    this.drawFrame();
    this.createCenterResourceHud();
    this.centerTrack();
    this.setUIFixed();
    this.scale.on("resize", () => {
      this.drawFrame();
      this.layoutUI();
      this.centerTrack();
      this.positionCenterResourceHud();
    });
    this.initCars();
    this.initTurn();
    this.updateStandings();
    this.recomputeTargets();
    this.drawTargets();
    this.layoutUI();
    this.createPitModal();
    this.createSkipButton();
    this.createDebugButtons();
    this.updateCycleHud();
    this.applyCarsAndMovesVisibility();
    this.updateExternalToggleLabel();
    this.setUIFixed();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener("srp:toggle-cars-moves", this.onExternalToggleCarsMoves);
      window.removeEventListener("srp:backend-lobby-state", this.onBackendLobbyState);
      window.removeEventListener("srp:backend-turn-applied", this.onBackendTurnApplied);
    });
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
      makeHudText: (cell) => this.makeHudText(cell),
      setHudText: (text) => this.txtInfo.setText(text),
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
        },
        cellScreenPos: (cellId) => {
          const cell = this.cellMap.get(cellId);
          if (!cell) return null;
          const cam = this.cameras.main;
          const rect = this.game.canvas.getBoundingClientRect();
          const sx = rect.width / this.scale.width;
          const sy = rect.height / this.scale.height;
          return {
            x: rect.left + (cell.pos.x - cam.worldView.x) * cam.zoom * sx,
            y: rect.top + (cell.pos.y - cam.worldView.y) * cam.zoom * sy
          };
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
      ...Array.from({ length: this.botCars }, (_, i) => ({ isBot: true, ownerId: `BOT${i + 1}` }))
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
    this.updateCycleHud();
    this.updateStandings();
    this.drawTargets();
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
  private applyBackendTurnApplied(lobbyId: string, playerId: string, action: AppliedTurnSummary) {
    if (this.backendLobbyId && lobbyId !== this.backendLobbyId) return;
    const car = this.cars.find((candidate) => candidate.ownerId === playerId);
    if (!car) return;
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
    body.setRotation(headingOf(cell, this.cellMap).angle() + Math.PI / 2);
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

  private refreshAfterTurn() {
    this.processBotsUntilHuman();
    this.syncTokens();
    this.updateActiveCarVisuals();
    this.recomputeTargets();
    this.drawTargets();
    this.updateSkipButtonState();
    this.updateCycleHud();
    this.updateStandings();
    if (this.raceFinished && !this.raceFinishedAnnounced) {
      this.raceFinishedAnnounced = true;
      window.dispatchEvent(
        new CustomEvent("srp:race-finished", { detail: { winnerCarId: this.winnerCarId } })
      );
    }
  }

  private syncTokens() {
    for (const car of this.cars) {
      const cell = this.cellMap.get(car.cellId);
      if (!cell) continue;
      const token = this.carTokens.get(car.carId);
      if (!token) continue;
      const body = token.first as Phaser.GameObjects.Image;
      body.setRotation(headingOf(cell, this.cellMap).angle() + Math.PI / 2);
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
    const fixed = [this.gFrame, this.txtInfo, this.txtCycle, this.skipButton].filter(Boolean);
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
    if (this.logPanel) this.logPanel.setFixed();
    if (this.standingsPanel) this.standingsPanel.setFixed();
    if (this.skipButton) this.skipButton.setFixed();
    if (this.debugButtons) this.debugButtons.setFixed();
  }

  private centerTrack() {
    const center = this.getTrackCenter();
    if (!center) return;
    this.cameras.main.centerOn(center.x, center.y);
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

  private createCenterResourceHud() {
    const center = this.getTrackCenter() ?? { x: 0, y: 0 };
    this.centerResourceBg = this.add.rectangle(center.x, center.y, 168, 62, 0x0f141b, 0.8);
    this.centerResourceBg.setStrokeStyle(1, 0x2a3642, 0.95);
    this.centerResourceBg.setDepth(62);

    this.txtCenterTire = this.add.text(center.x, center.y - 11, "", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#4cd964",
      fontStyle: "bold"
    });
    this.txtCenterTire.setOrigin(0.5, 0.5);
    this.txtCenterTire.setDepth(63);

    this.txtCenterFuel = this.add.text(center.x, center.y + 11, "", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#4cd964",
      fontStyle: "bold"
    });
    this.txtCenterFuel.setOrigin(0.5, 0.5);
    this.txtCenterFuel.setDepth(63);
  }

  private positionCenterResourceHud() {
    const center = this.getTrackCenter();
    if (!center) return;
    this.centerResourceBg.setPosition(center.x, center.y);
    this.txtCenterTire.setPosition(center.x, center.y - 11);
    this.txtCenterFuel.setPosition(center.x, center.y + 11);
  }

  private getResourcePercentColor(percent: number): string {
    const clamped = Phaser.Math.Clamp(percent, 0, 100);
    const amber = { r: 255, g: 176, b: 32 };
    const red = { r: 255, g: 77, b: 77 };
    if (clamped >= 20) return "#4cd964";

    // Under 20% we switch to warning colors immediately (amber -> red).
    const t = (20 - clamped) / 20;
    const r = Math.round(amber.r + (red.r - amber.r) * t);
    const g = Math.round(amber.g + (red.g - amber.g) * t);
    const b = Math.round(amber.b + (red.b - amber.b) * t);
    const toHex = (value: number) => value.toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  private updateCenterResourceHud() {
    if (!this.activeCar) return;
    this.txtCenterTire.setText(`Tire ${Math.round(this.activeCar.tire)}%`);
    this.txtCenterFuel.setText(`Fuel ${Math.round(this.activeCar.fuel)}%`);
    this.txtCenterTire.setColor(this.getResourcePercentColor(this.activeCar.tire));
    this.txtCenterFuel.setColor(this.getResourcePercentColor(this.activeCar.fuel));
  }

  private addLog(line: string) {
    this.logPanel.addLine(line);
  }

  private toggleForwardIndexOverlay() {
    this.showForwardIndex = !this.showForwardIndex;
    this.renderForwardIndexOverlay();
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
    const pad = ui.padding;
    const standingsHeight = Math.max(
      ui.standingsPanel.minHeight,
      this.standingsPanel.getPreferredHeight()
    );
    const standingsY = Math.max(
      pad,
      Math.min(h - standingsHeight - pad, Math.round((h - standingsHeight) / 2))
    );

    this.uiLogRect = {
      x: w - ui.logPanel.width - pad,
      y: pad,
      w: ui.logPanel.width,
      h: ui.logPanel.height
    };
    this.uiStandingsRect = {
      x: pad,
      y: standingsY,
      w: ui.standingsPanel.width,
      h: standingsHeight
    };

    this.txtCycle.setPosition(w / 2, RaceScene.HUD.cyclePosY);
    this.txtDebugHint.setPosition(RaceScene.HUD.debugHintPos.x, RaceScene.HUD.debugHintPos.y);
    this.logPanel.setRect(this.uiLogRect, ui.logPadding);
    this.standingsPanel.setRect(
      this.uiStandingsRect,
      ui.standingsHeaderOffset,
      ui.standingsTextOffset,
      ui.standingsModeOffsetX
    );

    if (this.skipButton) {
      this.skipButton.setPosition(w / 2, h - ui.bottomButtonYPad);
    }
    if (this.debugButtons) {
      this.debugButtons.layout(w, h, pad, ui.bottomButtonYPad);
    }

    this.logPanel.draw();
    this.standingsPanel.draw();
  }

  private updateStandings() {
    if (this.standingsPanel.isCollapsed()) {
      const resized = this.standingsPanel.setLines([]);
      if (resized) this.layoutUI();
      return;
    }
    const ordered =
      this.standingsPanel.getMode() === "carId"
        ? [...this.cars].sort((a, b) => a.carId - b.carId)
        : sortCarsByProgress(this.cars, this.cellMap, {
            turnOrder: this.turn.order,
            turnIndex: this.turn.index
          });
    const lines = ordered.map((car, index) => {
      const cell = this.cellMap.get(car.cellId);
      const fwd = cell?.forwardIndex ?? -1;
      const lap = car.lapCount ?? 0;
      const winnerTag = this.winnerCarId === car.carId ? "  WIN" : "";
      return `${index + 1}. Car ${car.carId}  lap ${lap}/${this.raceLapTarget}  fwd ${fwd}${winnerTag}`;
    });
    const resized = this.standingsPanel.setLines(lines);
    if (resized) this.layoutUI();
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

  private updateCycleHud() {
    if (this.raceFinished && this.winnerCarId != null) {
      this.txtCycle.setText(
        `Race finished: Car ${this.winnerCarId} wins at ${this.raceLapTarget} laps`
      );
      this.updateCenterResourceHud();
      return;
    }
    const cycle = this.activeCar.moveCycle;
    const parts = cycle.spent.map((v, i) => (i === cycle.index ? `[${v}]` : `${v}`));
    const remaining = getRemainingBudget(this.activeCar.moveCycle);
    this.txtCycle.setText(
      `Move budget: ${parts.join("-")}  Remaining ${remaining}/40  Laps to win ${this.raceLapTarget}`
    );
    this.updateCenterResourceHud();
  }

  private computeCostFactors(laneIndex: number) {
    const setup = this.activeCar.setup;
    const aero = 1 + (setup.wingFrontDeg + setup.wingRearDeg) * 0.01;
    const psi =
      1 +
      (Math.abs(setup.psi.fl - 32) +
        Math.abs(setup.psi.fr - 32) +
        Math.abs(setup.psi.rl - 32) +
        Math.abs(setup.psi.rr - 32)) *
        0.002;
    const laneT = laneIndex === INNER_MAIN_LANE ? 1.05 : laneIndex === OUTER_MAIN_LANE ? 0.98 : 1.0;
    const laneF = laneIndex === INNER_MAIN_LANE ? 0.98 : laneIndex === OUTER_MAIN_LANE ? 1.03 : 1.0;
    return { aero, psi, laneT, laneF };
  }
}
