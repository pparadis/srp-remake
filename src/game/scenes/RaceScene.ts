import Phaser from "phaser";
import type { TrackData, TrackCell } from "../types/track";
import type { Car } from "../types/car";
import { trackSchema } from "../../validation/trackSchema";
import {
  INNER_MAIN_LANE,
  MIDDLE_MAIN_LANE,
  OUTER_MAIN_LANE,
  PIT_LANE,
  REG_BOT_CARS,
  REG_HUMAN_CARS,
  REG_TOTAL_CARS
} from "../constants";
import { computeValidTargets, type TargetInfo } from "../systems/movementSystem";
import { buildTrackIndex, type TrackIndex } from "../systems/trackIndex";
import { computeMoveSpend, getRemainingBudget, recordMove } from "../systems/moveBudgetSystem";
import { applyMove } from "../systems/moveCommitSystem";
import { advancePitPenalty, applyPitStop, shouldDisallowPitBoxTargets } from "../systems/pitSystem";
import { validateMoveAttempt } from "../systems/moveValidationSystem";
import { spawnCars } from "../systems/spawnSystem";
import { sortCarsByProgress } from "../systems/orderingSystem";
import { advanceTurn, createTurnState, getCurrentCarId, type TurnState } from "../systems/turnSystem";
import { validateTrack } from "../../validation/trackValidation";
import { PitModal } from "./ui/PitModal";
import { LogPanel } from "./ui/LogPanel";
import { StandingsPanel } from "./ui/StandingsPanel";
import { TextButton } from "./ui/TextButton";
import { decideBotActionWithTrace, type BotDecisionTrace } from "../systems/botSystem";

type CellMap = Map<string, TrackCell>;

interface BotDecisionLogEntry {
  seq: number;
  turnIndex: number;
  carId: number;
  fromCellId: string;
  state: Car["state"];
  tire: number;
  fuel: number;
  pitServiced: boolean;
  validTargets: Array<{
    cellId: string;
    distance: number;
    tireCost: number;
    fuelCost: number;
    isPitTrigger: boolean;
  }>;
  action: {
    type: "skip" | "pit" | "move";
    targetCellId?: string;
    moveSpend?: number;
    note?: string;
  };
  trace: {
    lowResources: boolean;
    heuristics: { lowResourceThreshold: number; pitBonus: number; pitPenalty: number };
    selectedCellId: string | null;
    candidates: Array<{
      cellId: string;
      score: number;
      distance: number;
      tireCost: number;
      fuelCost: number;
      isPitTrigger: boolean;
    }>;
  } | null;
}

type BotDecisionShortLogEntry = Omit<BotDecisionLogEntry, "validTargets" | "trace">;

export class RaceScene extends Phaser.Scene {
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
  private static readonly MOVE_RATES = {
    softTire: 0.5,
    hardTire: 0.35,
    fuel: 0.45
  };
  private static readonly MOVE_BUDGET = {
    baseMax: 9,
    zeroResourceMax: 4
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
  private trackIndex!: TrackIndex;

  private gTrack!: Phaser.GameObjects.Graphics;
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
  private cars: Car[] = [];
  private activeCar!: Car;
  private carTokens: Map<number, Phaser.GameObjects.Container> = new Map();
  private activeHalos: Map<number, Phaser.GameObjects.Ellipse> = new Map();
  private activeHaloTween: Phaser.Tweens.Tween | null = null;
  private validTargets: Map<string, TargetInfo> = new Map();
  private targetCostLabels: Phaser.GameObjects.Text[] = [];
  private dragOrigin: { x: number; y: number } | null = null;
  private pendingPit:
    | { cell: TrackCell; origin: { x: number; y: number }; originCellId: string; distance: number }
    | null = null;
  private turn!: TurnState;
  private pitModal!: PitModal;
  private totalCars = 1;
  private humanCars = 1;
  private botCars = 0;
  private botDecisionLog: BotDecisionLogEntry[] = [];
  private botDecisionSeq = 1;
  private skipButton!: TextButton;
  private copyDebugButton!: TextButton;
  private copyBotDebugButton!: TextButton;
  private copyBotDebugShortButton!: TextButton;
  private showCarsAndMoves = true;
  private readonly onExternalToggleCarsMoves = () => {
    this.showCarsAndMoves = !this.showCarsAndMoves;
    this.updateExternalToggleLabel();
    this.applyCarsAndMovesVisibility();
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
      const msg = parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("\\n");
      throw new Error(`Invalid track JSON:\\n${msg}`);
    }

    this.track = parsed.data as TrackData;
    const validationErrors = validateTrack(this.track);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid track data:\\n${validationErrors.map((e) => `- ${e}`).join("\\n")}`);
    }
    this.cellMap = new Map(this.track.cells.map((c) => [c.id, c]));
    this.trackIndex = buildTrackIndex(this.track);
    const rawTotal = Number(this.registry.get(REG_TOTAL_CARS) ?? 1);
    const rawHumans = Number(this.registry.get(REG_HUMAN_CARS) ?? 1);
    const rawBots = Number(this.registry.get(REG_BOT_CARS) ?? 0);
    this.totalCars = Number.isNaN(rawTotal) ? 1 : Math.max(1, Math.min(11, rawTotal));
    this.humanCars = Number.isNaN(rawHumans) ? 1 : Math.max(0, Math.min(this.totalCars, rawHumans));
    this.botCars = Number.isNaN(rawBots) ? 0 : Math.max(0, Math.min(this.totalCars - this.humanCars, rawBots));

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
      "Debug: F = forwardIndex overlay",
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
    this.createCopyDebugButton();
    this.createCopyBotDebugButton();
    this.createCopyBotDebugShortButton();
    this.updateCycleHud();
    this.applyCarsAndMovesVisibility();
    this.updateExternalToggleLabel();
    this.setUIFixed();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener("srp:toggle-cars-moves", this.onExternalToggleCarsMoves);
    });
    window.addEventListener("srp:toggle-cars-moves", this.onExternalToggleCarsMoves);

    this.input.on("dragstart", (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      if (this.pitModal.isActive()) return;
      const token = this.getActiveToken();
      if (!token || obj !== token) return;
      this.recomputeTargets();
      this.drawTargets();
      this.dragOrigin = { x: token.x, y: token.y };
    });

    this.input.on("drag", (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject, x: number, y: number) => {
      if (this.pitModal.isActive()) return;
      const token = this.getActiveToken();
      if (!token || obj !== token) return;
      token.setPosition(x, y);
      const halo = this.activeHalos.get(this.activeCar.carId);
      if (halo) halo.setPosition(x, y);
    });

    this.input.on("dragend", (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      if (this.pitModal.isActive()) return;
      const token = this.getActiveToken();
      if (!token || obj !== token) return;
      const origin = this.dragOrigin ?? { x: token.x, y: token.y };
      const cell = this.findNearestCell(token.x, token.y, 18);
      const fromCell = this.cellMap.get(this.activeCar.cellId) ?? null;
      const validation = validateMoveAttempt(this.activeCar, fromCell, cell, this.validTargets, obj === token);
      if (validation.ok && cell && validation.info && validation.moveSpend != null) {
        const info = validation.info;
        const prevCellId = this.activeCar.cellId;
        this.activeCar.cellId = cell.id;
        token.setPosition(cell.pos.x, cell.pos.y);
        this.activeCar.pitExitBoost = false;
        if (cell.laneIndex !== PIT_LANE) {
          this.activeCar.pitServiced = false;
        }
        if (validation.isPitStop) {
          this.openPitModal(cell, origin, prevCellId, validation.moveSpend);
        } else {
          const fromCell = this.cellMap.get(prevCellId);
          if (fromCell) {
            applyMove(this.activeCar, fromCell, cell, info, validation.moveSpend);
          } else {
            applyMove(this.activeCar, cell, cell, info, validation.moveSpend);
          }
          this.addLog(`Car ${this.activeCar.carId} moved to ${cell.id}.`);
          this.advanceTurnAndRefresh();
        }
      } else {
        const currentCell = this.cellMap.get(this.activeCar.cellId);
        if (currentCell) {
          token.setPosition(currentCell.pos.x, currentCell.pos.y);
          const halo = this.activeHalos.get(this.activeCar.carId);
          if (halo) halo.setPosition(currentCell.pos.x, currentCell.pos.y);
        } else {
          token.setPosition(origin.x, origin.y);
          const halo = this.activeHalos.get(this.activeCar.carId);
          if (halo) halo.setPosition(origin.x, origin.y);
        }
      }
      this.dragOrigin = null;
    });

    this.input.on("pointermove", (p: Phaser.Input.Pointer) => {
    const cell = this.findNearestCell(p.worldX, p.worldY, RaceScene.HUD.hoverMaxDist);
      this.txtInfo.setText(this.makeHudText(cell));
    });

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      const cell = this.findNearestCell(p.worldX, p.worldY, RaceScene.HUD.hoverMaxDist);
      if (!cell) return;
      void this.copyCellId(cell.id);
      this.recomputeTargets();
      this.drawTargets();
    });

    this.input.keyboard?.on("keydown-F", () => {
      this.toggleForwardIndexOverlay();
    });

    this.txtInfo.setText(this.makeHudText(null));
  }

  private initCars() {
    const { cars, tokens } = spawnCars(this.track, {
      totalCars: this.totalCars,
      humanCount: this.humanCars,
      botCount: this.botCars
    });
    this.cars = cars;
    for (const entry of tokens) {
      this.spawnCarToken(entry.car, entry.color);
    }
    this.activeCar = this.getFirstCar();
  }

  private spawnCarToken(car: Car, color: number) {
    const cell = this.cellMap.get(car.cellId);
    if (!cell) return;
    const halo = this.add.ellipse(cell.pos.x, cell.pos.y, 34, 22);
    halo.setStrokeStyle(3, 0xfff27a, 0.95);
    halo.setFillStyle(0xfff27a, 0.08);
    halo.setVisible(false);
    halo.setDepth(60);
    this.activeHalos.set(car.carId, halo);

    const body = this.add.rectangle(0, 0, 26, 16, color, 1);
    body.setStrokeStyle(2, 0x1a1a1a, 1);

    const label = this.add.text(0, 0, String(car.carId), {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#0b0f14"
    });
    label.setOrigin(0.5, 0.5);

    const token = this.add.container(cell.pos.x, cell.pos.y, [body, label]);
    token.setDepth(50);
    token.setSize(28, 18);
    token.setInteractive({ useHandCursor: true });
    this.carTokens.set(car.carId, token);
  }

  private initTurn() {
    this.turn = createTurnState(this.cars);
    const currentId = getCurrentCarId(this.turn);
    this.activeCar = this.cars.find((c) => c.carId === currentId) ?? this.getFirstCar();
    this.addLog(`Car ${this.activeCar.carId} to play.`);
    this.updateActiveCarVisuals();
    this.processBotsUntilHuman();
  }

  private advanceTurnAndRefresh() {
    advanceTurn(this.turn);
    this.selectNextPlayable();
    this.processBotsUntilHuman();
    this.recomputeTargets();
    this.drawTargets();
    this.updateSkipButtonState();
    this.updateCycleHud();
    this.updateStandings();
  }

  private processBotsUntilHuman() {
    const maxBots = Math.max(1, this.cars.length);
    let steps = 0;
    while (this.activeCar.isBot && steps < maxBots) {
      this.executeBotTurn();
      advanceTurn(this.turn);
      this.selectNextPlayable();
      steps += 1;
    }
  }

  private selectNextPlayable() {
    const maxSkips = Math.max(1, this.cars.length);
    for (let i = 0; i < maxSkips; i++) {
      const currentId = getCurrentCarId(this.turn);
      const car = this.cars.find((c) => c.carId === currentId) ?? this.getFirstCar();
      if (advancePitPenalty(car)) {
        recordMove(car.moveCycle, 0);
        this.addLog(`Car ${car.carId} pit penalty (remaining ${car.pitTurnsRemaining}).`);
        advanceTurn(this.turn);
        continue;
      }
      this.activeCar = car;
      this.addLog(`Car ${this.activeCar.carId} to play.`);
      this.updateActiveCarVisuals();
      return;
    }

    const currentId = getCurrentCarId(this.turn);
    this.activeCar = this.cars.find((c) => c.carId === currentId) ?? this.getFirstCar();
    this.addLog(`Car ${this.activeCar.carId} to play.`);
    this.updateActiveCarVisuals();
    this.updateCycleHud();
  }

  private getFirstCar(): Car {
    const first = this.cars[0];
    if (!first) {
      throw new Error("No cars available.");
    }
    return first;
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
        token.setAlpha(1);
        token.setScale(1.1);
        this.input.setDraggable(token, true);
        if (halo) {
          halo.setPosition(token.x, token.y);
          halo.setVisible(true);
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
    if (activeHalo) {
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
    const occupied = new Set(this.cars.map((c) => c.cellId));
    const baseMaxSteps = car.tire === 0 || car.fuel === 0
      ? RaceScene.MOVE_BUDGET.zeroResourceMax
      : RaceScene.MOVE_BUDGET.baseMax;
    const remainingBudget = getRemainingBudget(car.moveCycle);
    const maxSteps = Math.min(baseMaxSteps, Math.max(0, remainingBudget));
    const tireRate = car.setup.compound === "soft"
      ? RaceScene.MOVE_RATES.softTire
      : RaceScene.MOVE_RATES.hardTire;
    const fuelRate = RaceScene.MOVE_RATES.fuel;
    const activeCell = this.cellMap.get(car.cellId);
    const inPitLane = activeCell?.laneIndex === PIT_LANE;
    return computeValidTargets(this.trackIndex, car.cellId, occupied, maxSteps, {
      allowPitExitSkip: car.pitExitBoost,
      disallowPitBoxTargets: shouldDisallowPitBoxTargets(car, inPitLane)
    }, {
      tireRate,
      fuelRate,
      setup: car.setup
    });
  }

  private drawTargets() {
    this.gTargets.clear();
    this.clearTargetCostLabels();
    if (!this.showCarsAndMoves) return;
    this.gTargets.lineStyle(2, 0xffffff, 0.35);

    for (const [cellId, info] of this.validTargets) {
      const cell = this.cellMap.get(cellId);
      if (!cell) continue;

      const ringRadius = 12 + Math.max(0, 9 - info.distance);
      const dotRadius = 10;
      const color = info.isPitTrigger ? 0xffe066 : 0x66ccff;
      this.gTargets.lineStyle(2, color, 0.8);
      this.gTargets.strokeCircle(cell.pos.x, cell.pos.y, ringRadius);
      this.gTargets.fillStyle(color, 0.9);
      this.gTargets.fillCircle(cell.pos.x, cell.pos.y, dotRadius);
      this.gTargets.lineStyle(1, 0x0b0f14, 0.95);
      this.gTargets.strokeCircle(cell.pos.x, cell.pos.y, dotRadius);

      const costLabel = this.add.text(
        cell.pos.x,
        cell.pos.y,
        this.formatTargetCost(info, cell.laneIndex),
        {
          fontFamily: "monospace",
          fontSize: "11px",
          color: "#0b0f14",
          fontStyle: "bold"
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
    const moveSpend = info.moveSpend ?? computeMoveSpend(info.distance, fromLaneIndex, targetLaneIndex);
    return String(moveSpend);
  }

  private drawFrame() {
    this.gFrame.clear();
    this.gFrame.lineStyle(1, 0x2a3642, 0.8);
    this.gFrame.strokeRect(1, 1, this.scale.width - 2, this.scale.height - 2);
  }

  private setUIFixed() {
    const fixed = [
      this.gFrame,
      this.txtInfo,
      this.txtCycle,
      this.skipButton,
      this.copyDebugButton,
      this.copyBotDebugButton,
      this.copyBotDebugShortButton
    ].filter(Boolean);
    for (const obj of fixed) {
      if (typeof (obj as { setScrollFactor?: (x: number, y?: number) => unknown }).setScrollFactor === "function") {
        (obj as unknown as { setScrollFactor: (x: number, y?: number) => unknown }).setScrollFactor(0);
      }
    }
    if (this.pitModal) {
      this.pitModal.setFixed();
    }
    if (this.logPanel) this.logPanel.setFixed();
    if (this.standingsPanel) this.standingsPanel.setFixed();
    if (this.skipButton) this.skipButton.setFixed();
    if (this.copyDebugButton) this.copyDebugButton.setFixed();
    if (this.copyBotDebugButton) this.copyBotDebugButton.setFixed();
    if (this.copyBotDebugShortButton) this.copyBotDebugShortButton.setFixed();
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
    const standingsHeight = Math.max(ui.standingsPanel.minHeight, this.standingsPanel.getPreferredHeight());
    const standingsY = Math.max(
      pad,
      Math.min(h - standingsHeight - pad, Math.round((h - standingsHeight) / 2))
    );

    this.uiLogRect = { x: w - ui.logPanel.width - pad, y: pad, w: ui.logPanel.width, h: ui.logPanel.height };
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
    const leftButtons = [this.copyDebugButton, this.copyBotDebugButton, this.copyBotDebugShortButton]
      .filter(Boolean) as TextButton[];
    if (leftButtons.length > 0) {
      let x = pad + 4;
      let y = h - ui.bottomButtonYPad;
      const gap = 8;
      for (const button of leftButtons) {
        const textObj = button.getText();
        const width = textObj.width;
        if (x + width > w - pad) {
          x = pad + 4;
          y -= textObj.height + gap;
        }
        button.setPosition(x, y);
        x += width + gap;
      }
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
    const ordered = this.standingsPanel.getMode() === "carId"
      ? [...this.cars].sort((a, b) => a.carId - b.carId)
      : sortCarsByProgress(this.cars, this.cellMap, {
        turnOrder: this.turn.order,
        turnIndex: this.turn.index
      });
    const lines = ordered.map((car, index) => {
      const cell = this.cellMap.get(car.cellId);
      const fwd = cell?.forwardIndex ?? -1;
      const lap = car.lapCount ?? 0;
      return `${index + 1}. Car ${car.carId}  lap ${lap}  fwd ${fwd}`;
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

  private createCopyDebugButton() {
    this.copyDebugButton = new TextButton(this, "Copy debug", {
      fontSize: "14px",
      originX: 0,
      originY: 1,
      onClick: () => this.copyDebugSnapshot()
    });
    this.layoutUI();
    this.setUIFixed();
  }

  private createCopyBotDebugButton() {
    this.copyBotDebugButton = new TextButton(this, "Copy bot debug", {
      fontSize: "14px",
      originX: 0,
      originY: 1,
      onClick: () => this.copyBotDecisionSnapshot()
    });
    this.layoutUI();
    this.setUIFixed();
  }

  private createCopyBotDebugShortButton() {
    this.copyBotDebugShortButton = new TextButton(this, "Copy bot debug short", {
      fontSize: "14px",
      originX: 0,
      originY: 1,
      onClick: () => this.copyShortBotDecisionSnapshot()
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
    if (!this.showCarsAndMoves) {
      if (this.activeHaloTween) {
        this.activeHaloTween.stop();
        this.activeHaloTween = null;
      }
      this.gTargets.clear();
      this.clearTargetCostLabels();
      for (const token of this.carTokens.values()) {
        token.setVisible(false);
        this.input.setDraggable(token, false);
      }
      for (const halo of this.activeHalos.values()) {
        halo.setVisible(false);
      }
      return;
    }

    for (const token of this.carTokens.values()) {
      token.setVisible(true);
    }
    this.updateActiveCarVisuals();
    this.drawTargets();
  }

  private updateSkipButtonState() {
    if (!this.skipButton) return;
    const canSkip = this.validTargets.size === 0 && this.activeCar.state === "ACTIVE";
    this.skipButton.setAlpha(canSkip ? 1 : 0.4);
    this.skipButton.setInteractive(canSkip);
  }

  private serializeTargets(targets: Map<string, TargetInfo>) {
    return Array.from(targets.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([cellId, info]) => ({
        cellId,
        distance: info.distance,
        tireCost: info.tireCost,
        fuelCost: info.fuelCost,
        isPitTrigger: info.isPitTrigger
      }));
  }

  private serializeTrace(trace: BotDecisionTrace | null): BotDecisionLogEntry["trace"] {
    if (!trace) return null;
    return {
      lowResources: trace.lowResources,
      heuristics: { ...trace.heuristics },
      selectedCellId: trace.selectedCellId,
      candidates: trace.candidates.map((candidate) => ({
        cellId: candidate.cellId,
        score: candidate.score,
        distance: candidate.info.distance,
        tireCost: candidate.info.tireCost,
        fuelCost: candidate.info.fuelCost,
        isPitTrigger: candidate.info.isPitTrigger
      }))
    };
  }

  private appendBotDecision(
    entry: Omit<BotDecisionLogEntry, "seq" | "turnIndex" | "carId" | "fromCellId" | "state" | "tire" | "fuel" | "pitServiced">,
    fromCellId?: string
  ) {
    this.botDecisionLog.push({
      seq: this.botDecisionSeq++,
      turnIndex: this.turn.index,
      carId: this.activeCar.carId,
      fromCellId: fromCellId ?? this.activeCar.cellId,
      state: this.activeCar.state,
      tire: this.activeCar.tire,
      fuel: this.activeCar.fuel,
      pitServiced: this.activeCar.pitServiced,
      ...entry
    });
    if (this.botDecisionLog.length > RaceScene.BOT_LOG_LIMIT) {
      this.botDecisionLog.shift();
    }
  }

  private buildDebugSnapshot() {
    const spineLane = 1;
    const spineCells = this.track.cells.filter((c) => c.laneIndex === spineLane);
    const startFinishIds = this.track.cells
      .filter((c) => (c.tags ?? []).includes("START_FINISH"))
      .map((c) => c.id);
    const occupiedByCell = Object.fromEntries(this.cars.map((car) => [car.cellId, car.carId]));
    const cars = this.cars
      .map((car) => {
        const cell = this.cellMap.get(car.cellId);
        return {
          carId: car.carId,
          cellId: car.cellId,
          isBot: car.isBot,
          lapCount: car.lapCount ?? 0,
          state: car.state,
          tire: car.tire,
          fuel: car.fuel,
          pitTurnsRemaining: car.pitTurnsRemaining,
          pitExitBoost: car.pitExitBoost,
          pitServiced: car.pitServiced,
          setup: car.setup,
          cell: cell
            ? {
                zoneIndex: cell.zoneIndex,
                laneIndex: cell.laneIndex,
                forwardIndex: cell.forwardIndex,
                tags: cell.tags ?? []
              }
            : null
        };
      })
      .sort((a, b) => a.carId - b.carId);
    const activeCell = this.cellMap.get(this.activeCar.cellId);
    const occupied = new Set(this.cars.map((c) => c.cellId));
    const baseMaxSteps = this.activeCar.tire === 0 || this.activeCar.fuel === 0
      ? RaceScene.MOVE_BUDGET.zeroResourceMax
      : RaceScene.MOVE_BUDGET.baseMax;
    const remainingBudget = getRemainingBudget(this.activeCar.moveCycle);
    const maxSteps = Math.min(baseMaxSteps, Math.max(0, remainingBudget));
    const tireRate = this.activeCar.setup.compound === "soft"
      ? RaceScene.MOVE_RATES.softTire
      : RaceScene.MOVE_RATES.hardTire;
    const fuelRate = RaceScene.MOVE_RATES.fuel;
    const inPitLane = activeCell?.laneIndex === PIT_LANE;
    const validTargets = Array.from(this.validTargets.entries()).map(([cellId, info]) => ({
      cellId,
      distance: info.distance,
      moveSpend: info.moveSpend ?? null,
      tireCost: info.tireCost,
      fuelCost: info.fuelCost,
      isPitTrigger: info.isPitTrigger
    }));
    return {
      version: this.buildInfo.version,
      gitSha: this.buildInfo.gitSha,
      trackId: this.track.trackId,
      spineLane,
      spineLength: spineCells.length,
      startFinishIds,
      activeCarId: this.activeCar.carId,
      movement: {
        maxSteps: inPitLane ? 1 : maxSteps,
        tireRate,
        fuelRate,
        allowPitExitSkip: this.activeCar.pitExitBoost,
        disallowPitBoxTargets: shouldDisallowPitBoxTargets(this.activeCar, inPitLane),
        occupied: Array.from(occupied),
        validTargets
      },
      occupiedByCell,
      cars,
      botDecisionCount: this.botDecisionLog.length
    };
  }

  private toShortBotDecisionLogEntry(entry: BotDecisionLogEntry): BotDecisionShortLogEntry {
    const { validTargets: _validTargets, trace: _trace, ...shortEntry } = entry;
    return shortEntry;
  }

  private buildBotDecisionSnapshot(shortMode = false) {
    return {
      version: this.buildInfo.version,
      gitSha: this.buildInfo.gitSha,
      trackId: this.track.trackId,
      botDecisionCount: this.botDecisionLog.length,
      shortMode,
      botDecisions: shortMode
        ? this.botDecisionLog.map((entry) => this.toShortBotDecisionLogEntry(entry))
        : this.botDecisionLog
    };
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
    if (this.validTargets.size !== 0 || this.activeCar.state !== "ACTIVE") return;
    recordMove(this.activeCar.moveCycle, 0);
    this.addLog(`Car ${this.activeCar.carId} skipped (no moves).`);
    this.advanceTurnAndRefresh();
  }

  private executeBotTurn() {
    if (this.activeCar.state !== "ACTIVE") {
      this.appendBotDecision({
        validTargets: [],
        action: { type: "skip", note: "inactive" },
        trace: null
      });
      recordMove(this.activeCar.moveCycle, 0);
      this.addLog(`Car ${this.activeCar.carId} skipped (inactive).`);
      return;
    }
    const targets = this.computeTargetsForCar(this.activeCar);
    const targetSnapshot = this.serializeTargets(targets);
    const decision = decideBotActionWithTrace(targets, this.activeCar, this.cellMap);
    const action = decision.action;
    const trace = this.serializeTrace(decision.trace);

    if (action.type === "skip") {
      this.appendBotDecision({
        validTargets: targetSnapshot,
        action: { type: "skip", note: "no-target" },
        trace
      });
      recordMove(this.activeCar.moveCycle, 0);
      this.addLog(`Car ${this.activeCar.carId} skipped (no moves).`);
      return;
    }
    const fromCell = this.cellMap.get(this.activeCar.cellId);
    if (!fromCell) {
      this.appendBotDecision({
        validTargets: targetSnapshot,
        action: { type: "skip", note: "invalid-origin-cell" },
        trace
      });
      recordMove(this.activeCar.moveCycle, 0);
      this.addLog(`Car ${this.activeCar.carId} skipped (invalid target).`);
      return;
    }

    if (action.type === "pit") {
      applyPitStop(this.activeCar, action.target.id, this.activeCar.setup);
      recordMove(this.activeCar.moveCycle, action.info.distance);
      this.appendBotDecision({
        validTargets: targetSnapshot,
        action: { type: "pit", targetCellId: action.target.id, moveSpend: action.info.distance },
        trace
      }, fromCell.id);
      this.logPitStop(action.target);
    } else {
      applyMove(this.activeCar, fromCell, action.target, action.info, action.moveSpend);
      this.appendBotDecision({
        validTargets: targetSnapshot,
        action: { type: "move", targetCellId: action.target.id, moveSpend: action.moveSpend },
        trace
      }, fromCell.id);
      this.addLog(`Car ${this.activeCar.carId} moved to ${action.target.id}.`);
    }

    const token = this.getActiveToken();
    if (token) token.setPosition(action.target.pos.x, action.target.pos.y);
  }

  private openPitModal(cell: TrackCell, origin: { x: number; y: number }, originCellId: string, distance: number) {
    this.pendingPit = { cell, origin, originCellId, distance };
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
        applyPitStop(this.activeCar, this.pendingPit.cell.id, setup);
        this.logPitStop(this.pendingPit.cell);
        recordMove(this.activeCar.moveCycle, this.pendingPit.distance);
        this.closePitModal();
        this.advanceTurnAndRefresh();
      },
      onCancel: () => {
        if (!this.pendingPit) return;
        this.activeCar.cellId = this.pendingPit.originCellId;
        const token = this.getActiveToken();
        if (token) token.setPosition(origin.x, origin.y);
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

  private logPitStop(cell: TrackCell) {
    this.addLog(`Car ${this.activeCar.carId} pit stop at ${cell.id}.`);
  }

  private getActiveToken(): Phaser.GameObjects.Container | null {
    return this.carTokens.get(this.activeCar.carId) ?? null;
  }

  private laneColor(laneIndex: number): number {
    if (laneIndex === PIT_LANE) return 0xb87cff;
    if (laneIndex === INNER_MAIN_LANE) return 0x3aa0ff;
    if (laneIndex === MIDDLE_MAIN_LANE) return 0x66ff99;
    if (laneIndex === OUTER_MAIN_LANE) return 0xffcc66;
    return 0xffffff;
  }

  private buildLanePath(laneIndex: number): TrackCell[] {
    const laneCells = this.track.cells.filter((c) => c.laneIndex === laneIndex);
    if (laneCells.length === 0) return [];

    const laneIds = new Set(laneCells.map((c) => c.id));
    const incoming = new Map<string, number>();
    for (const cell of laneCells) incoming.set(cell.id, 0);

    for (const cell of laneCells) {
      for (const nextId of cell.next) {
        if (!laneIds.has(nextId)) continue;
        incoming.set(nextId, (incoming.get(nextId) ?? 0) + 1);
      }
    }

    let start = laneCells.find((c) => (incoming.get(c.id) ?? 0) === 0);
    if (!start) {
      start = laneCells.reduce((best, c) => (c.zoneIndex < best.zoneIndex ? c : best), laneCells[0]!);
    }

    const path: TrackCell[] = [];
    const visited = new Set<string>();
    let current: TrackCell | undefined = start;
    while (current && !visited.has(current.id)) {
      path.push(current);
      visited.add(current.id);
      const nextId: string | undefined = current.next.find(
        (n: string) => laneIds.has(n) && !visited.has(n)
      );
      current = nextId ? this.cellMap.get(nextId) : undefined;
    }

    if (path.length < laneCells.length) {
      const remaining = laneCells
        .filter((c) => !visited.has(c.id))
        .sort((a, b) => a.zoneIndex - b.zoneIndex);
      path.push(...remaining);
    }

    return path;
  }

  private drawLaneRibbon(path: TrackCell[], laneIndex: number) {
    if (path.length < 2) return;

    const outerWidth = laneIndex === PIT_LANE ? 16 : 20;
    const innerWidth = laneIndex === PIT_LANE ? 11 : 14;
    const innerAlpha = laneIndex === PIT_LANE ? 0.42 : 0.34;

    const first = path[0];
    const last = path[path.length - 1];
    if (!first || !last) return;
    const closesLoop = last.next.some((nextId) => {
      const nextCell = this.cellMap.get(nextId);
      return nextCell?.id === first.id && nextCell.laneIndex === laneIndex;
    });

    this.strokeLanePath(path, closesLoop, outerWidth, 0x0b0f14, 0.55);
    this.strokeLanePath(path, closesLoop, innerWidth, this.laneColor(laneIndex), innerAlpha);
  }

  private smoothLanePoints(path: TrackCell[], closesLoop: boolean, iterations = 2): Phaser.Math.Vector2[] {
    let points = path.map((cell) => new Phaser.Math.Vector2(cell.pos.x, cell.pos.y));
    if (points.length < 3) return points;

    for (let iter = 0; iter < iterations; iter += 1) {
      const next: Phaser.Math.Vector2[] = [];

      if (closesLoop) {
        for (let i = 0; i < points.length; i += 1) {
          const a = points[i];
          const b = points[(i + 1) % points.length];
          if (!a || !b) continue;
          next.push(new Phaser.Math.Vector2(0.75 * a.x + 0.25 * b.x, 0.75 * a.y + 0.25 * b.y));
          next.push(new Phaser.Math.Vector2(0.25 * a.x + 0.75 * b.x, 0.25 * a.y + 0.75 * b.y));
        }
      } else {
        const first = points[0];
        const last = points[points.length - 1];
        if (!first || !last) return points;
        next.push(first.clone());
        for (let i = 0; i < points.length - 1; i += 1) {
          const a = points[i];
          const b = points[i + 1];
          if (!a || !b) continue;
          next.push(new Phaser.Math.Vector2(0.75 * a.x + 0.25 * b.x, 0.75 * a.y + 0.25 * b.y));
          next.push(new Phaser.Math.Vector2(0.25 * a.x + 0.75 * b.x, 0.25 * a.y + 0.75 * b.y));
        }
        next.push(last.clone());
      }

      points = next;
      if (points.length < 3) break;
    }

    return points;
  }

  private strokeLanePath(path: TrackCell[], closesLoop: boolean, width: number, color: number, alpha: number) {
    if (path.length < 2) return;
    const points = this.smoothLanePoints(path, closesLoop, 2);
    if (points.length < 2) return;

    this.gTrack.lineStyle(width, color, alpha);

    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i];
      const to = points[i + 1];
      if (!from || !to) continue;
      this.gTrack.lineBetween(from.x, from.y, to.x, to.y);
    }

    if (closesLoop) {
      const first = points[0];
      const last = points[points.length - 1];
      if (!first || !last) return;
      this.gTrack.lineBetween(last.x, last.y, first.x, first.y);
    }
  }

  private drawPitConnectors() {
    const drawn = new Set<string>();

    for (const from of this.track.cells) {
      for (const nextId of from.next) {
        const to = this.cellMap.get(nextId);
        if (!to) continue;

        const isPitTransition = from.laneIndex === PIT_LANE || to.laneIndex === PIT_LANE;
        const isCrossLane = from.laneIndex !== to.laneIndex;
        if (!isPitTransition || !isCrossLane) continue;

        const key = [from.id, to.id].sort().join("|");
        if (drawn.has(key)) continue;
        drawn.add(key);

        this.gTrack.lineStyle(12, 0x0b0f14, 0.6);
        this.gTrack.lineBetween(from.pos.x, from.pos.y, to.pos.x, to.pos.y);
        this.gTrack.lineStyle(8, this.laneColor(PIT_LANE), 0.55);
        this.gTrack.lineBetween(from.pos.x, from.pos.y, to.pos.x, to.pos.y);
      }
    }
  }

  private drawTrack() {
    this.gTrack.clear();

    for (let lane = 0; lane < this.track.lanes; lane += 1) {
      this.drawLaneRibbon(this.buildLanePath(lane), lane);
    }
    this.drawPitConnectors();

    for (const c of this.track.cells) {
      const r = 4;
      const fill = this.laneColor(c.laneIndex);

      this.gTrack.fillStyle(fill, 1);
      this.gTrack.fillCircle(c.pos.x, c.pos.y, r);

      this.gTrack.lineStyle(1, 0x0b0f14, 1);
      this.gTrack.strokeCircle(c.pos.x, c.pos.y, r + 1);

      const tags = c.tags ?? [];
      if (tags.includes("PIT_BOX")) {
        this.gTrack.lineStyle(3, 0xff2d95, 1);
        this.gTrack.strokeCircle(c.pos.x, c.pos.y, r + 3);
        this.gTrack.lineStyle(1, 0xffffff, 0.8);
        this.gTrack.strokeCircle(c.pos.x, c.pos.y, r + 1);
      }
    }

    if (this.showForwardIndex) {
      this.gTrack.lineStyle(1, 0xffffff, 0.2);
      for (const c of this.track.cells) {
        for (const n of c.next) {
          const to = this.cellMap.get(n);
          if (!to) continue;
          this.gTrack.lineBetween(c.pos.x, c.pos.y, to.pos.x, to.pos.y);
        }
      }
    }

    this.renderForwardIndexOverlay();
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
      const activeStatus = `Active: Car ${this.activeCar.carId}\nTire: ${this.activeCar.tire}% \nFuel: ${this.activeCar.fuel}%`;
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
    const cycle = this.activeCar.moveCycle;
    const parts = cycle.spent.map((v, i) => (i === cycle.index ? `[${v}]` : `${v}`));
    const remaining = getRemainingBudget(this.activeCar.moveCycle);
    this.txtCycle.setText(`Move budget: ${parts.join("-")}  Remaining ${remaining}/40`);
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
