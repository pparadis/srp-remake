import Phaser from "phaser";
import type { TrackData, TrackCell } from "../types/track";
import type { Car } from "../types/car";
import { trackSchema } from "../../validation/trackSchema";
import { REG_PLAYER_COUNT } from "../constants";
import { computeValidTargets, type TargetInfo } from "../systems/movementSystem";
import { buildTrackIndex, type TrackIndex } from "../systems/trackIndex";
import { getRemainingBudget, recordMove } from "../systems/moveBudgetSystem";
import { applyMove } from "../systems/moveCommitSystem";
import { advancePitPenalty, applyPitStop, shouldDisallowPitBoxTargets } from "../systems/pitSystem";
import { validateMoveAttempt } from "../systems/moveValidationSystem";
import { spawnCars } from "../systems/spawnSystem";
import { buildProgressMap, sortCarsByProgress } from "../systems/orderingSystem";
import { advanceTurn, createTurnState, getCurrentCarId, type TurnState } from "../systems/turnSystem";

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
  private gUI!: Phaser.GameObjects.Graphics;
  private gFrame!: Phaser.GameObjects.Graphics;
  private txtInfo!: Phaser.GameObjects.Text;
  private txtCycle!: Phaser.GameObjects.Text;
  private txtLog!: Phaser.GameObjects.Text;
  private txtStandings!: Phaser.GameObjects.Text;
  private txtStandingsHeader!: Phaser.GameObjects.Text;
  private txtStandingsMode!: Phaser.GameObjects.Text;
  private txtDebugHint!: Phaser.GameObjects.Text;
  private standingsCollapsed = false;
  private standingsMode: "carId" | "race" = "carId";
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
  private logLines: string[] = [];
  private modal!: Phaser.GameObjects.Container;
  private modalActive = false;
  private modalTitle!: Phaser.GameObjects.Text;
  private modalBody!: Phaser.GameObjects.Text;
  private modalConfirm!: Phaser.GameObjects.Text;
  private modalCancel!: Phaser.GameObjects.Text;
  private modalSetup: Car["setup"] | null = null;
  private modalValueTexts: Record<string, Phaser.GameObjects.Text> = {};
  private playerCount = 1;
  private skipButton!: Phaser.GameObjects.Text;
  private copyDebugButton!: Phaser.GameObjects.Text;
  private readonly buildInfo = {
    version: "debug-snapshot-v2",
    gitSha: "6f74be4bcbc6a61e09402b831578945c836c8341"
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
    this.cellMap = new Map(this.track.cells.map((c) => [c.id, c]));
    this.trackIndex = buildTrackIndex(this.track);
    this.progressMap = buildProgressMap(this.track, 1);
    const rawCount = Number(this.registry.get(REG_PLAYER_COUNT) ?? 1);
    this.playerCount = Number.isNaN(rawCount) ? 1 : Math.max(1, Math.min(11, rawCount));

    this.gTrack = this.add.graphics();
    this.gTargets = this.add.graphics();
    this.gUI = this.add.graphics();
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
    this.txtLog = this.add.text(0, 0, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#c7d1db",
      lineSpacing: 4,
      wordWrap: { width: 260 }
    });
    this.txtStandingsHeader = this.add.text(0, 0, "Standings [-]", {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#e6edf3"
    });
    this.txtStandingsHeader.setInteractive({ useHandCursor: true });
    this.txtStandingsHeader.on("pointerdown", () => {
      this.standingsCollapsed = !this.standingsCollapsed;
      this.layoutUI();
      this.updateStandings();
    });

    this.txtStandingsMode = this.add.text(0, 0, "Mode: Id", {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#9fb0bf"
    });
    this.txtStandingsMode.setInteractive({ useHandCursor: true });
    this.txtStandingsMode.on("pointerdown", () => {
      this.standingsMode = this.standingsMode === "carId" ? "race" : "carId";
      this.updateStandingsModeLabel();
      this.updateStandings();
    });

    this.txtStandings = this.add.text(0, 0, "", {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#c7d1db",
      lineSpacing: 4,
      wordWrap: { width: 220 }
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
    this.updateStandingsModeLabel();
    this.createPitModal();
    this.createSkipButton();
    this.createCopyDebugButton();
    this.updateCycleHud();
    this.setUIFixed();

    this.input.on("dragstart", (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      if (this.modalActive) return;
      const token = this.getActiveToken();
      if (!token || obj !== token) return;
      this.recomputeTargets();
      this.drawTargets();
      this.dragOrigin = { x: token.x, y: token.y };
    });

    this.input.on("drag", (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject, x: number, y: number) => {
      if (this.modalActive) return;
      const token = this.getActiveToken();
      if (!token || obj !== token) return;
      token.setPosition(x, y);
    });

    this.input.on("dragend", (_: Phaser.Input.Pointer, obj: Phaser.GameObjects.GameObject) => {
      if (this.modalActive) return;
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
        if (cell.laneIndex !== 3) {
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
    const { cars, tokens } = spawnCars(this.track, { playerCount: this.playerCount });
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
  }

  private advanceTurnAndRefresh() {
    advanceTurn(this.turn);
    this.selectNextPlayable();
    this.recomputeTargets();
    this.drawTargets();
    this.updateSkipButtonState();
    this.updateCycleHud();
    this.updateStandings();
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
    const activeCell = this.cellMap.get(this.activeCar.cellId);
    const inPitLane = activeCell?.laneIndex === 3;
    const effectiveMaxSteps = inPitLane ? 1 : maxSteps;
    this.validTargets = computeValidTargets(this.trackIndex, this.activeCar.cellId, occupied, effectiveMaxSteps, {
      allowPitExitSkip: this.activeCar.pitExitBoost,
      disallowPitBoxTargets: shouldDisallowPitBoxTargets(this.activeCar, inPitLane)
    }, {
      tireRate,
      fuelRate,
      setup: this.activeCar.setup
    });
    this.updateSkipButtonState();
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

  private drawLogPanel() {
    this.gUI.clear();
    this.gUI.fillStyle(0x0f141b, 0.95);
    this.gUI.fillRoundedRect(
      this.uiLogRect.x,
      this.uiLogRect.y,
      this.uiLogRect.w,
      this.uiLogRect.h,
      RaceScene.UI.logPanel.radius
    );
    this.gUI.lineStyle(1, 0x2a3642, 1);
    this.gUI.strokeRoundedRect(
      this.uiLogRect.x,
      this.uiLogRect.y,
      this.uiLogRect.w,
      this.uiLogRect.h,
      RaceScene.UI.logPanel.radius
    );
  }

  private drawFrame() {
    this.gFrame.clear();
    this.gFrame.lineStyle(1, 0x2a3642, 0.8);
    this.gFrame.strokeRect(1, 1, this.scale.width - 2, this.scale.height - 2);
  }

  private setUIFixed() {
    const fixed = [
      this.gUI,
      this.gFrame,
      this.txtInfo,
      this.txtCycle,
      this.txtLog,
      this.txtStandingsHeader,
      this.txtStandingsMode,
      this.txtStandings,
      this.skipButton,
      this.copyDebugButton
    ].filter(Boolean);
    for (const obj of fixed) {
      if (typeof (obj as { setScrollFactor?: (x: number, y?: number) => unknown }).setScrollFactor === "function") {
        (obj as unknown as { setScrollFactor: (x: number, y?: number) => unknown }).setScrollFactor(0);
      }
    }
    if (this.modal) {
      if (typeof (this.modal as { setScrollFactor?: (x: number, y?: number) => unknown }).setScrollFactor === "function") {
        (this.modal as unknown as { setScrollFactor: (x: number, y?: number) => unknown }).setScrollFactor(0);
      }
      for (const child of this.modal.list) {
        if (typeof (child as { setScrollFactor?: (x: number, y?: number) => unknown }).setScrollFactor === "function") {
          (child as unknown as { setScrollFactor: (x: number, y?: number) => unknown }).setScrollFactor(0);
        }
      }
    }
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
    this.logLines.push(line);
    if (this.logLines.length > 8) this.logLines.shift();
    this.txtLog.setText(this.logLines.join("\n"));
  }

  private updateStandingsModeLabel() {
    this.txtStandingsMode.setText(this.standingsMode === "carId" ? "Mode: Id" : "Mode: Race");
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

  private updateStandingsPanel() {
    if (this.standingsCollapsed) {
      this.txtStandingsHeader.setText("Standings [+]");
      this.txtStandings.setVisible(false);
      this.txtStandingsMode.setVisible(false);
      return;
    }
    this.gUI.fillStyle(0x0f141b, 0.97);
    this.gUI.fillRoundedRect(
      this.uiStandingsRect.x,
      this.uiStandingsRect.y,
      this.uiStandingsRect.w,
      this.uiStandingsRect.h,
      RaceScene.UI.standingsPanel.radius
    );
    this.gUI.lineStyle(1, 0x2a3642, 1);
    this.gUI.strokeRoundedRect(
      this.uiStandingsRect.x,
      this.uiStandingsRect.y,
      this.uiStandingsRect.w,
      this.uiStandingsRect.h,
      RaceScene.UI.standingsPanel.radius
    );

    this.txtStandingsHeader.setText("Standings [-]");
    this.txtStandings.setVisible(!this.standingsCollapsed);
    this.txtStandingsMode.setVisible(!this.standingsCollapsed);
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
    this.txtLog.setPosition(this.uiLogRect.x + ui.logPadding, this.uiLogRect.y + ui.logPadding);
    this.txtLog.setWordWrapWidth(this.uiLogRect.w - ui.logPadding * 2);

    this.txtStandingsHeader.setPosition(
      this.uiStandingsRect.x + ui.standingsHeaderOffset.x,
      this.uiStandingsRect.y + ui.standingsHeaderOffset.y
    );
    this.txtStandingsMode.setPosition(
      this.uiStandingsRect.x + ui.standingsModeOffsetX,
      this.uiStandingsRect.y + ui.standingsHeaderOffset.y
    );
    this.txtStandings.setPosition(
      this.uiStandingsRect.x + ui.standingsTextOffset.x,
      this.uiStandingsRect.y + ui.standingsTextOffset.y
    );
    this.txtStandings.setWordWrapWidth(this.uiStandingsRect.w - ui.standingsTextOffset.x * 2);

    if (this.skipButton) {
      this.skipButton.setPosition(w / 2, h - ui.bottomButtonYPad);
    }
    if (this.copyDebugButton) {
      this.copyDebugButton.setPosition(pad + 4, h - ui.bottomButtonYPad);
    }

    this.drawLogPanel();
    this.updateStandingsPanel();
  }

  private updateStandings() {
    if (this.standingsCollapsed) {
      this.txtStandings.setText("");
      return;
    }
    const ordered = this.standingsMode === "carId"
      ? [...this.cars].sort((a, b) => a.carId - b.carId)
      : sortCarsByProgress(this.cars, this.cellMap, this.progressMap);
    const lines = ordered.map((car, index) => {
      const cell = this.cellMap.get(car.cellId);
      const fwd = cell?.forwardIndex ?? -1;
      const lap = car.lapCount ?? 0;
      return `${index + 1}. Car ${car.carId}  lap ${lap}  fwd ${fwd}`;
    });
    this.txtStandings.setText(lines.join("\n"));
  }

  private createPitModal() {
    const panel = this.add.graphics();
    panel.fillStyle(0x0f141b, 0.98);
    panel.fillRoundedRect(320, 200, 460, 270, 10);
    panel.lineStyle(1, 0x2a3642, 1);
    panel.strokeRoundedRect(320, 200, 460, 270, 10);

    this.modalTitle = this.add.text(350, 220, "Pit stop", {
      fontFamily: "monospace",
      fontSize: "18px",
      color: "#e6edf3"
    });
    this.modalBody = this.add.text(350, 255, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#c7d1db",
      lineSpacing: 4,
      wordWrap: { width: 400 }
    });

    const fieldY = 330;
    const lineH = 26;
    const labelX = 350;
    const valueX = 470;
    const controlX = 620;

    const compoundLabel = this.add.text(labelX, fieldY, "Compound", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#9fb0bf"
    });
    const compoundValue = this.add.text(valueX, fieldY, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#e6edf3"
    });
    const compoundToggle = this.createModalButton(controlX, fieldY - 6, "Toggle");
    compoundToggle.setScale(0.85);
    compoundToggle.on("pointerdown", () => {
      if (!this.modalSetup) return;
      this.modalSetup.compound = this.modalSetup.compound === "soft" ? "hard" : "soft";
      this.refreshModalValues();
    });

    const psiLabel = this.add.text(labelX, fieldY + lineH, "PSI FL/FR/RL/RR", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#9fb0bf"
    });
    const psiValue = this.add.text(labelX, fieldY + lineH + 12, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#e6edf3"
    });
    const psiMinus = this.createModalButton(controlX, fieldY + lineH + 8, "-");
    const psiPlus = this.createModalButton(controlX + 40, fieldY + lineH + 8, "+");
    psiMinus.setScale(0.85);
    psiPlus.setScale(0.85);
    psiMinus.on("pointerdown", () => this.adjustPsi(-1));
    psiPlus.on("pointerdown", () => this.adjustPsi(1));

    const wingLabel = this.add.text(labelX, fieldY + lineH * 2 + 16, "Wing F/R", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#9fb0bf"
    });
    const wingValue = this.add.text(valueX, fieldY + lineH * 2 + 16, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#e6edf3"
    });
    const wingMinus = this.createModalButton(controlX, fieldY + lineH * 2 + 12, "-");
    const wingPlus = this.createModalButton(controlX + 40, fieldY + lineH * 2 + 12, "+");
    wingMinus.setScale(0.85);
    wingPlus.setScale(0.85);
    wingMinus.on("pointerdown", () => this.adjustWing(-1));
    wingPlus.on("pointerdown", () => this.adjustWing(1));

    this.modalValueTexts = {
      compound: compoundValue,
      psi: psiValue,
      wing: wingValue
    };

    this.modalConfirm = this.createModalButton(360, 435, "Confirm");
    this.modalCancel = this.createModalButton(520, 435, "Cancel");

    this.modal = this.add.container(0, 0, [
      panel,
      this.modalTitle,
      this.modalBody,
      compoundLabel,
      compoundValue,
      compoundToggle,
      psiLabel,
      psiValue,
      psiMinus,
      psiPlus,
      wingLabel,
      wingValue,
      wingMinus,
      wingPlus,
      this.modalConfirm,
      this.modalCancel
    ]);
    this.modal.setDepth(100);
    this.modal.setVisible(false);
  }

  private createModalButton(x: number, y: number, label: string): Phaser.GameObjects.Text {
    const txt = this.add.text(x, y, label, {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#0b0f14",
      backgroundColor: "#c7d1db",
      padding: { x: 10, y: 6 }
    });
    txt.setInteractive({ useHandCursor: true });
    txt.on("pointerover", () => txt.setStyle({ backgroundColor: "#e6edf3" }));
    txt.on("pointerout", () => txt.setStyle({ backgroundColor: "#c7d1db" }));
    return txt;
  }

  private createSkipButton() {
    this.skipButton = this.add.text(0, 0, "Skip turn", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#0b0f14",
      backgroundColor: "#c7d1db",
      padding: { x: 10, y: 6 }
    });
    this.skipButton.setOrigin(0.5, 1);
    this.skipButton.setInteractive({ useHandCursor: true });
    this.skipButton.on("pointerover", () => this.skipButton.setStyle({ backgroundColor: "#e6edf3" }));
    this.skipButton.on("pointerout", () => this.skipButton.setStyle({ backgroundColor: "#c7d1db" }));
    this.skipButton.on("pointerdown", () => this.skipTurn());
    this.updateSkipButtonState();
    this.layoutUI();
    this.setUIFixed();
  }

  private createCopyDebugButton() {
    this.copyDebugButton = this.add.text(0, 0, "Copy debug", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#0b0f14",
      backgroundColor: "#c7d1db",
      padding: { x: 10, y: 6 }
    });
    this.copyDebugButton.setOrigin(0, 1);
    this.copyDebugButton.setInteractive({ useHandCursor: true });
    this.copyDebugButton.on("pointerover", () => this.copyDebugButton.setStyle({ backgroundColor: "#e6edf3" }));
    this.copyDebugButton.on("pointerout", () => this.copyDebugButton.setStyle({ backgroundColor: "#c7d1db" }));
    this.copyDebugButton.on("pointerdown", () => this.copyDebugSnapshot());
    this.layoutUI();
    this.setUIFixed();
  }

  private updateSkipButtonState() {
    if (!this.skipButton) return;
    const canSkip = this.validTargets.size === 0 && this.activeCar.state === "ACTIVE";
    this.skipButton.setAlpha(canSkip ? 1 : 0.4);
    if (canSkip) {
      this.skipButton.setInteractive({ useHandCursor: true });
    } else {
      this.skipButton.disableInteractive();
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
    const inPitLane = activeCell?.laneIndex === 3;
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

  private openPitModal(cell: TrackCell, origin: { x: number; y: number }, originCellId: string, distance: number) {
    this.pendingPit = { cell, origin, originCellId, distance };
    this.modalSetup = structuredClone(this.activeCar.setup);
    this.modalBody.setText(
      [
        `Drop on PIT_BOX: ${cell.id}`,
        `Setup will be applied.`,
        `Tires and fuel refilled to 100.`,
        `Pit penalty: lose 1 turn.`
      ].join("\n")
    );
    this.refreshModalValues();
    this.modal.setVisible(true);
    this.modalActive = true;
    const token = this.getActiveToken();
    if (token) token.disableInteractive();

    this.modalConfirm.removeAllListeners("pointerdown");
    this.modalCancel.removeAllListeners("pointerdown");

    this.modalConfirm.once("pointerdown", () => {
      if (!this.pendingPit) return;
      applyPitStop(this.activeCar, this.pendingPit.cell.id, this.modalSetup);
      this.logPitStop(this.pendingPit.cell);
      recordMove(this.activeCar.moveCycle, this.pendingPit.distance);
      this.closePitModal();
      this.advanceTurnAndRefresh();
    });

    this.modalCancel.once("pointerdown", () => {
      if (!this.pendingPit) return;
      this.activeCar.cellId = this.pendingPit.originCellId;
      const token = this.getActiveToken();
      if (token) token.setPosition(origin.x, origin.y);
      this.closePitModal();
      this.recomputeTargets();
      this.drawTargets();
    });
  }

  private closePitModal() {
    this.pendingPit = null;
    this.modalSetup = null;
    this.modal.setVisible(false);
    this.modalActive = false;
    const token = this.getActiveToken();
    if (token) token.setInteractive({ useHandCursor: true });
  }

  private logPitStop(cell: TrackCell) {
    this.addLog(`Car ${this.activeCar.carId} pit stop at ${cell.id}.`);
  }

  private refreshModalValues() {
    if (!this.modalSetup) return;
    const compound = this.modalValueTexts.compound;
    const psi = this.modalValueTexts.psi;
    const wing = this.modalValueTexts.wing;
    if (compound) compound.setText(this.modalSetup.compound);
    if (psi) {
      psi.setText(
        `${this.modalSetup.psi.fl}/${this.modalSetup.psi.fr}/${this.modalSetup.psi.rl}/${this.modalSetup.psi.rr}`
      );
    }
    if (wing) wing.setText(`${this.modalSetup.wingFrontDeg}/${this.modalSetup.wingRearDeg}`);
  }

  private adjustPsi(delta: number) {
    if (!this.modalSetup) return;
    const clamp = (v: number) => Math.max(15, Math.min(35, v + delta));
    this.modalSetup.psi.fl = clamp(this.modalSetup.psi.fl);
    this.modalSetup.psi.fr = clamp(this.modalSetup.psi.fr);
    this.modalSetup.psi.rl = clamp(this.modalSetup.psi.rl);
    this.modalSetup.psi.rr = clamp(this.modalSetup.psi.rr);
    this.refreshModalValues();
  }

  private adjustWing(delta: number) {
    if (!this.modalSetup) return;
    const clamp = (v: number) => Math.max(0, Math.min(20, v + delta));
    this.modalSetup.wingFrontDeg = clamp(this.modalSetup.wingFrontDeg);
    this.modalSetup.wingRearDeg = clamp(this.modalSetup.wingRearDeg);
    this.refreshModalValues();
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
