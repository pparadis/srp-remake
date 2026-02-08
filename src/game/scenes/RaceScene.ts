import Phaser from "phaser";
import type { TrackData, TrackCell } from "../types/track";
import type { Car } from "../types/car";
import { trackSchema } from "../../validation/trackSchema";
import {
  INNER_MAIN_LANE,
  OUTER_MAIN_LANE,
  PIT_LANE,
  REG_BOT_CARS,
  REG_HUMAN_CARS,
  REG_RACE_LAPS,
  REG_TOTAL_CARS
} from "../constants";
import { computeValidTargets, type TargetInfo } from "../systems/movementSystem";
import { buildTrackIndex, type TrackIndex } from "../systems/trackIndex";
import { computeMoveSpend, getRemainingBudget, recordMove } from "../systems/moveBudgetSystem";
import { advancePitPenalty, applyPitStop, shouldDisallowPitBoxTargets } from "../systems/pitSystem";
import { spawnCars } from "../systems/spawnSystem";
import { sortCarsByProgress } from "../systems/orderingSystem";
import { advanceTurn, createTurnState, getCurrentCarId, type TurnState } from "../systems/turnSystem";
import { validateTrack } from "../../validation/trackValidation";
import { PitModal } from "./ui/PitModal";
import { LogPanel } from "./ui/LogPanel";
import { StandingsPanel } from "./ui/StandingsPanel";
import { DebugButtons } from "./ui/DebugButtons";
import { TextButton } from "./ui/TextButton";
import { applyCarsMovesVisibility } from "./ui/carsMovesVisibility";
import { executeBotTurn } from "./turns/executeBotTurn";
import { drawTrack as drawTrackGraphics } from "./rendering/trackRenderer";
import { registerRaceSceneInputHandlers } from "./input/registerRaceSceneInputHandlers";
import {
  type BotDecisionAppendEntry,
  appendBotDecisionEntry,
  buildBotDecisionSnapshot as buildBotDecisionSnapshotPayload,
  type BotDecisionLogEntry
} from "./debug/botDecisionDebug";
import { buildGameDebugSnapshot } from "./debug/gameDebugSnapshot";

type CellMap = Map<string, TrackCell>;

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
  private raceLapTarget = 5;
  private raceFinished = false;
  private winnerCarId: number | null = null;
  private botDecisionLog: BotDecisionLogEntry[] = [];
  private botDecisionSeq = 1;
  private skipButton!: TextButton;
  private debugButtons!: DebugButtons;
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
    const rawRaceLaps = Number(this.registry.get(REG_RACE_LAPS) ?? 5);
    this.totalCars = Number.isNaN(rawTotal) ? 1 : Math.max(1, Math.min(11, rawTotal));
    this.humanCars = Number.isNaN(rawHumans) ? 1 : Math.max(0, Math.min(this.totalCars, rawHumans));
    this.botCars = Number.isNaN(rawBots) ? 0 : Math.max(0, Math.min(this.totalCars - this.humanCars, rawBots));
    this.raceLapTarget = Number.isNaN(rawRaceLaps) ? 5 : Math.max(1, Math.min(999, Math.trunc(rawRaceLaps)));

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
    this.createDebugButtons();
    this.updateCycleHud();
    this.applyCarsAndMovesVisibility();
    this.updateExternalToggleLabel();
    this.setUIFixed();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      window.removeEventListener("srp:toggle-cars-moves", this.onExternalToggleCarsMoves);
    });
    window.addEventListener("srp:toggle-cars-moves", this.onExternalToggleCarsMoves);

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
      openPitModal: (cell, origin, originCellId, distance) => this.openPitModal(cell, origin, originCellId, distance),
      addLog: (line) => this.addLog(line),
      advanceTurnAndRefresh: () => this.advanceTurnAndRefresh(),
      hoverMaxDist: RaceScene.HUD.hoverMaxDist,
      dragSnapDist: 18
    });
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
    if (this.finalizeRaceIfNeeded()) return;
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
    if (this.raceFinished) return;
    const maxBots = Math.max(1, this.cars.length);
    let steps = 0;
    while (this.activeCar.isBot && steps < maxBots && !this.raceFinished) {
      this.executeBotTurn();
      if (this.finalizeRaceIfNeeded()) return;
      advanceTurn(this.turn);
      this.selectNextPlayable();
      steps += 1;
    }
  }

  private selectNextPlayable() {
    if (this.raceFinished) return;
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

  private findWinnerCar(): Car | null {
    if ((this.activeCar.lapCount ?? 0) >= this.raceLapTarget) {
      return this.activeCar;
    }
    return this.cars.find((car) => (car.lapCount ?? 0) >= this.raceLapTarget) ?? null;
  }

  private finalizeRaceIfNeeded(): boolean {
    if (this.raceFinished) return true;
    const winner = this.findWinnerCar();
    if (!winner) return false;

    this.raceFinished = true;
    this.winnerCarId = winner.carId;
    this.activeCar = winner;
    this.validTargets = new Map();
    this.drawTargets();
    this.updateSkipButtonState();
    this.updateActiveCarVisuals();
    this.updateCycleHud();
    this.updateStandings();
    this.addLog(`Race finished. Car ${winner.carId} wins (${winner.lapCount ?? 0}/${this.raceLapTarget} laps).`);
    return true;
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
        this.input.setDraggable(token, !this.raceFinished);
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
    if (this.raceFinished) {
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
      this.skipButton
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
    const canSkip = !this.raceFinished && this.validTargets.size === 0 && this.activeCar.state === "ACTIVE";
    this.skipButton.setAlpha(canSkip ? 1 : 0.4);
    this.skipButton.setInteractive(canSkip);
  }

  private appendBotDecision(
    entry: BotDecisionAppendEntry,
    fromCellId?: string
  ) {
    this.botDecisionSeq = appendBotDecisionEntry(
      this.botDecisionLog,
      RaceScene.BOT_LOG_LIMIT,
      this.botDecisionSeq,
      this.turn.index,
      this.activeCar,
      entry,
      fromCellId
    );
  }

  private buildDebugSnapshot() {
    const inPitLane = (this.cellMap.get(this.activeCar.cellId)?.laneIndex ?? -1) === PIT_LANE;
    return buildGameDebugSnapshot({
      buildInfo: this.buildInfo,
      track: this.track,
      cellMap: this.cellMap,
      cars: this.cars,
      activeCar: this.activeCar,
      validTargets: this.validTargets,
      botDecisionCount: this.botDecisionLog.length,
      moveBudget: RaceScene.MOVE_BUDGET,
      moveRates: RaceScene.MOVE_RATES,
      disallowPitBoxTargets: shouldDisallowPitBoxTargets(this.activeCar, inPitLane)
    });
  }

  private buildBotDecisionSnapshot(shortMode = false) {
    return buildBotDecisionSnapshotPayload(this.buildInfo, this.track.trackId, this.botDecisionLog, shortMode);
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
    if (this.validTargets.size !== 0 || this.activeCar.state !== "ACTIVE") return;
    recordMove(this.activeCar.moveCycle, 0);
    this.addLog(`Car ${this.activeCar.carId} skipped (no moves).`);
    this.advanceTurnAndRefresh();
  }

  private executeBotTurn() {
    if (this.raceFinished) return;
    const target = executeBotTurn({
      activeCar: this.activeCar,
      cellMap: this.cellMap,
      computeTargetsForCar: (car) => this.computeTargetsForCar(car),
      appendBotDecision: (entry, fromCellId) => this.appendBotDecision(entry, fromCellId),
      addLog: (line) => this.addLog(line),
      onPitStop: (cell) => this.logPitStop(cell)
    });
    if (!target) return;
    const token = this.getActiveToken();
    if (token) token.setPosition(target.pos.x, target.pos.y);
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

  private drawTrack() {
    drawTrackGraphics({
      graphics: this.gTrack,
      track: this.track,
      cellMap: this.cellMap,
      showForwardIndex: this.showForwardIndex,
      renderForwardIndexOverlay: () => this.renderForwardIndexOverlay()
    });
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
      this.txtCycle.setText(`Race finished: Car ${this.winnerCarId} wins at ${this.raceLapTarget} laps`);
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
