import Phaser from "phaser";
import type { TrackData, TrackCell } from "../types/track";
import type { Car } from "../types/car";
import { trackSchema } from "../../validation/trackSchema";
import { PIT_LANE, REG_BOT_FILL, REG_BOT_MODE, REG_PLAYER_COUNT } from "../constants";
import { computeValidTargets, type TargetInfo } from "../systems/movementSystem";
import { buildTrackIndex, type TrackIndex } from "../systems/trackIndex";
import { computeMoveSpend, getRemainingBudget, recordMove } from "../systems/moveBudgetSystem";
import { applyMove } from "../systems/moveCommitSystem";
import { advancePitPenalty, applyPitStop, shouldDisallowPitBoxTargets, shouldOpenPitModal } from "../systems/pitSystem";
import { validateMoveAttempt } from "../systems/moveValidationSystem";
import { spawnCars } from "../systems/spawnSystem";
import { buildProgressMap, sortCarsByProgress } from "../systems/orderingSystem";
import { advanceTurn, createTurnState, getCurrentCarId, type TurnState } from "../systems/turnSystem";
import { validateTrack } from "../../validation/trackValidation";
import { PitModal } from "./ui/PitModal";
import { LogPanel } from "./ui/LogPanel";
import { StandingsPanel } from "./ui/StandingsPanel";
import { TextButton } from "./ui/TextButton";
import { decideBotAction } from "../systems/botSystem";

type CellMap = Map<string, TrackCell>;

export class RaceScene extends Phaser.Scene {
  private static readonly UI = {
    padding: 10,
    logPanel: { width: 290, height: 180, radius: 8 },
    standingsPanel: { width: 250, height: 160, radius: 8 },
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
  private logPanel!: LogPanel;
  private standingsPanel!: StandingsPanel;
  private showForwardIndex = false;
  private forwardIndexLabels: Phaser.GameObjects.Text[] = [];
  private progressMap!: Map<string, number>;
  private uiLogRect = { x: 0, y: 0, w: 0, h: 0 };
  private uiStandingsRect = { x: 0, y: 0, w: 0, h: 0 };
  private cars: Car[] = [];
  private activeCar!: Car;
  private carTokens: Map<number, Phaser.GameObjects.Container> = new Map();
  private validTargets: Map<string, TargetInfo> = new Map();
  private dragOrigin: { x: number; y: number } | null = null;
  private pendingPit:
    | { cell: TrackCell; origin: { x: number; y: number }; originCellId: string; distance: number }
    | null = null;
  private turn!: TurnState;
  private pitModal!: PitModal;
  private playerCount = 1;
  private botMode = false;
  private botFill = true;
  private skipButton!: TextButton;
  private copyDebugButton!: TextButton;
  private readonly buildInfo = {
    version: "debug-snapshot-v2",
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
    this.progressMap = buildProgressMap(this.track, 1);
    const rawCount = Number(this.registry.get(REG_PLAYER_COUNT) ?? 1);
    this.playerCount = Number.isNaN(rawCount) ? 1 : Math.max(1, Math.min(11, rawCount));
    this.botMode = Boolean(this.registry.get(REG_BOT_MODE) ?? false);
    this.botFill = Boolean(this.registry.get(REG_BOT_FILL) ?? true);

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
    this.centerTrack();
    this.setUIFixed();
    this.scale.on("resize", () => {
      this.drawFrame();
      this.layoutUI();
      this.centerTrack();
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
    this.updateCycleHud();
    this.setUIFixed();

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
    });

    this.input.on("dragend", (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      if (this.pitModal.isActive()) return;
      const token = this.getActiveToken();
      if (!token || obj !== token) return;
      const origin = this.dragOrigin ?? { x: token.x, y: token.y };
      const cell = this.findNearestCell(token.x, token.y, 18);
      const validation = validateMoveAttempt(this.activeCar, cell, this.validTargets, obj === token);
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
        } else {
          token.setPosition(origin.x, origin.y);
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
      console.log("Cell", cell.id, "zone", cell.zoneIndex, "lane", cell.laneIndex, "next", cell.next);
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
      playerCount: this.playerCount,
      botMode: this.botMode,
      botFill: this.botFill,
      humanCount: this.botMode ? 0 : 1
    });
    this.cars = cars;
    for (const entry of tokens) {
      this.spawnCarToken(entry.car, entry.color);
    }
    this.activeCar = this.getFirstCar();
    this.updateStandings();
  }

  private spawnCarToken(car: Car, color: number) {
    const cell = this.cellMap.get(car.cellId);
    if (!cell) return;
    const body = this.add.rectangle(0, 0, 26, 16, color, 1);
    body.setStrokeStyle(2, 0x1a1a1a, 1);

    const label = this.add.text(0, 0, String(car.carId), {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#0b0f14"
    });
    label.setOrigin(0.5, 0.5);

    const token = this.add.container(cell.pos.x, cell.pos.y, [body, label]);
    token.setDepth(10);
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
    for (const [carId, token] of this.carTokens.entries()) {
      if (carId === this.activeCar.carId) {
        token.setAlpha(1);
        token.setScale(1.1);
        this.input.setDraggable(token, true);
      } else {
        token.setAlpha(0.6);
        token.setScale(1);
        this.input.setDraggable(token, false);
      }
    }
  }

  private recomputeTargets() {
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
    const effectiveMaxSteps = inPitLane ? 1 : maxSteps;
    return computeValidTargets(this.trackIndex, car.cellId, occupied, effectiveMaxSteps, {
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
    this.gTargets.lineStyle(2, 0xffffff, 0.35);

    for (const [cellId, info] of this.validTargets) {
      const cell = this.cellMap.get(cellId);
      if (!cell) continue;

      const r = 10 + Math.max(0, 9 - info.distance);
      const color = info.isPitTrigger ? 0xffe066 : 0x66ccff;
      this.gTargets.lineStyle(2, color, 0.8);
      this.gTargets.strokeCircle(cell.pos.x, cell.pos.y, r);
    }
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
      this.copyDebugButton
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
  }

  private centerTrack() {
    const xs = this.track.cells.map((c) => c.pos.x);
    const ys = this.track.cells.map((c) => c.pos.y);
    if (xs.length === 0 || ys.length === 0) return;
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    this.cameras.main.centerOn(cx, cy);
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

    this.uiLogRect = { x: w - ui.logPanel.width - pad, y: pad, w: ui.logPanel.width, h: ui.logPanel.height };
    this.uiStandingsRect = {
      x: pad,
      y: h - ui.standingsPanel.height - pad,
      w: ui.standingsPanel.width,
      h: ui.standingsPanel.height
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
    if (this.copyDebugButton) {
      this.copyDebugButton.setPosition(pad + 4, h - ui.bottomButtonYPad);
    }

    this.logPanel.draw();
    this.standingsPanel.draw();
  }

  private updateStandings() {
    if (this.standingsPanel.isCollapsed()) {
      this.standingsPanel.setLines([]);
      return;
    }
    const ordered = this.standingsPanel.getMode() === "carId"
      ? [...this.cars].sort((a, b) => a.carId - b.carId)
      : sortCarsByProgress(this.cars, this.cellMap, this.progressMap);
    const lines = ordered.map((car, index) => {
      const cell = this.cellMap.get(car.cellId);
      const fwd = cell?.forwardIndex ?? -1;
      const lap = car.lapCount ?? 0;
      return `${index + 1}. Car ${car.carId}  lap ${lap}  fwd ${fwd}`;
    });
    this.standingsPanel.setLines(lines);
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

  private updateSkipButtonState() {
    if (!this.skipButton) return;
    const canSkip = this.validTargets.size === 0 && this.activeCar.state === "ACTIVE";
    this.skipButton.setAlpha(canSkip ? 1 : 0.4);
    this.skipButton.setInteractive(canSkip);
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
      cars
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

  private skipTurn() {
    if (this.validTargets.size !== 0 || this.activeCar.state !== "ACTIVE") return;
    recordMove(this.activeCar.moveCycle, 0);
    this.addLog(`Car ${this.activeCar.carId} skipped (no moves).`);
    this.advanceTurnAndRefresh();
  }

  private executeBotTurn() {
    if (this.activeCar.state !== "ACTIVE") {
      recordMove(this.activeCar.moveCycle, 0);
      this.addLog(`Car ${this.activeCar.carId} skipped (inactive).`);
      return;
    }
    const targets = this.computeTargetsForCar(this.activeCar);
    const action = decideBotAction(targets, this.activeCar, this.cellMap);
    if (action.type === "skip") {
      recordMove(this.activeCar.moveCycle, 0);
      this.addLog(`Car ${this.activeCar.carId} skipped (no moves).`);
      return;
    }
    const fromCell = this.cellMap.get(this.activeCar.cellId);
    if (!fromCell) {
      recordMove(this.activeCar.moveCycle, 0);
      this.addLog(`Car ${this.activeCar.carId} skipped (invalid target).`);
      return;
    }

    if (action.type === "pit") {
      applyPitStop(this.activeCar, action.target.id, this.activeCar.setup);
      recordMove(this.activeCar.moveCycle, action.info.distance);
      this.logPitStop(action.target);
    } else {
      applyMove(this.activeCar, fromCell, action.target, action.info, action.moveSpend);
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

  private drawTrack() {
    this.gTrack.clear();

    for (const c of this.track.cells) {
      const r = 6;

      const fill =
        c.laneIndex === 0 ? 0x3aa0ff :
        c.laneIndex === 1 ? 0x66ff99 :
        c.laneIndex === 2 ? 0xffcc66 :
        0xb87cff;

      this.gTrack.fillStyle(fill, 1);
      this.gTrack.fillCircle(c.pos.x, c.pos.y, r);

      this.gTrack.lineStyle(1, 0x0b0f14, 1);
      this.gTrack.strokeCircle(c.pos.x, c.pos.y, r + 1);

      const tags = c.tags ?? [];
      if (tags.includes("PIT_BOX")) {
        this.gTrack.lineStyle(3, 0xff2d95, 1);
        this.gTrack.strokeCircle(c.pos.x, c.pos.y, r + 4);
        this.gTrack.lineStyle(1, 0xffffff, 0.8);
        this.gTrack.strokeCircle(c.pos.x, c.pos.y, r + 1);
      }
    }

    this.gTrack.lineStyle(1, 0xffffff, 0.15);
    for (const c of this.track.cells) {
      for (const n of c.next) {
        const to = this.cellMap.get(n);
        if (!to) continue;
        this.gTrack.lineBetween(c.pos.x, c.pos.y, to.pos.x, to.pos.y);
      }
    }

    const byZone = new Map<number, TrackCell[]>();
    for (const c of this.track.cells) {
      const arr = byZone.get(c.zoneIndex) ?? [];
      arr.push(c);
      byZone.set(c.zoneIndex, arr);
    }

    for (let z = 1; z <= this.track.zones; z++) {
      const arr = byZone.get(z);
      if (!arr) continue;
      const labelCell = arr.find((c) => c.laneIndex === 0) ?? arr.find((c) => c.laneIndex === 1) ?? arr[0];
      if (!labelCell) continue;
      this.add.text(labelCell.pos.x + 10, labelCell.pos.y - 10, `${z}`, {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#9fb0bf"
      });
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
    const laneT = laneIndex === 0 ? 1.05 : laneIndex === 2 ? 0.98 : 1.0;
    const laneF = laneIndex === 0 ? 0.98 : laneIndex === 2 ? 1.03 : 1.0;
    return { aero, psi, laneT, laneF };
  }
}
