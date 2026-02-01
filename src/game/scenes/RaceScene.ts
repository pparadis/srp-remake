import Phaser from "phaser";
import type { TrackData, TrackCell } from "../types/track";
import type { Car } from "../types/car";
import { trackSchema } from "../../validation/trackSchema";
import { computeValidTargets, type TargetInfo } from "../systems/movementSystem";
import { advanceTurn, createTurnState, getCurrentCarId, type TurnState } from "../systems/turnSystem";

type CellMap = Map<string, TrackCell>;

export class RaceScene extends Phaser.Scene {
  private track!: TrackData;
  private cellMap!: CellMap;

  private gTrack!: Phaser.GameObjects.Graphics;
  private gTargets!: Phaser.GameObjects.Graphics;
  private gUI!: Phaser.GameObjects.Graphics;
  private txtInfo!: Phaser.GameObjects.Text;
  private txtLog!: Phaser.GameObjects.Text;
  private cars: Car[] = [];
  private activeCar!: Car;
  private carTokens: Map<number, Phaser.GameObjects.Container> = new Map();
  private validTargets: Map<string, TargetInfo> = new Map();
  private dragOrigin: { x: number; y: number } | null = null;
  private pendingPit: { cell: TrackCell; origin: { x: number; y: number }; originCellId: string } | null = null;
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

    this.gTrack = this.add.graphics();
    this.gTargets = this.add.graphics();
    this.gUI = this.add.graphics();
    this.txtInfo = this.add.text(14, 14, "", {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#c7d1db"
    });
    this.txtLog = this.add.text(820, 20, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#c7d1db",
      lineSpacing: 4,
      wordWrap: { width: 260 }
    });

    this.drawTrack();
    this.initCars();
    this.initTurn();
    this.recomputeTargets();
    this.drawTargets();
    this.drawLogPanel();
    this.createPitModal();

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
      if (cell && this.validTargets.has(cell.id)) {
        const info = this.validTargets.get(cell.id)!;
        const prevCellId = this.activeCar.cellId;
        this.activeCar.cellId = cell.id;
        token.setPosition(cell.pos.x, cell.pos.y);
        this.activeCar.pitExitBoost = false;
        if (cell.laneIndex !== 3) {
          this.activeCar.pitServiced = false;
        }
        if ((cell.tags ?? []).includes("PIT_BOX")) {
          this.openPitModal(cell, origin, prevCellId);
        } else {
          this.applyMoveCosts(info);
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
      const cell = this.findNearestCell(p.x, p.y, 18);
      this.txtInfo.setText(this.makeHudText(cell));
    });

    this.input.on("pointerdown", (p: Phaser.Input.Pointer) => {
      const cell = this.findNearestCell(p.x, p.y, 18);
      if (!cell) return;
      console.log("Cell", cell.id, "zone", cell.zoneIndex, "lane", cell.laneIndex, "next", cell.next);
      this.recomputeTargets();
      this.drawTargets();
    });

    this.txtInfo.setText(this.makeHudText(null));
  }

  private initCars() {
    const startCell =
      this.track.cells.find((c) => (c.tags ?? []).includes("START_FINISH")) ??
      this.track.cells[0];
    const secondaryCell =
      this.track.cells.find((c) => c.zoneIndex === startCell.zoneIndex && c.laneIndex !== startCell.laneIndex) ??
      this.track.cells.find((c) => c.zoneIndex !== startCell.zoneIndex) ??
      this.track.cells[1];

    const car1: Car = {
      carId: 1,
      ownerId: "P1",
      cellId: startCell.id,
      tire: 100,
      fuel: 100,
      setup: {
        compound: "soft",
        psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
        wingFrontDeg: 6,
        wingRearDeg: 12
      },
      state: "ACTIVE",
      pitTurnsRemaining: 0,
      pitExitBoost: false,
      pitServiced: false
    };

    const car2: Car = {
      carId: 2,
      ownerId: "P2",
      cellId: secondaryCell.id,
      tire: 100,
      fuel: 100,
      setup: {
        compound: "hard",
        psi: { fl: 24, fr: 24, rl: 22, rr: 22 },
        wingFrontDeg: 5,
        wingRearDeg: 11
      },
      state: "ACTIVE",
      pitTurnsRemaining: 0,
      pitExitBoost: false,
      pitServiced: false
    };

    this.cars = [car1, car2];
    this.activeCar = car1;

    this.spawnCarToken(car1, 0xe94cff);
    this.spawnCarToken(car2, 0x35d0c7);
  }

  private spawnCarToken(car: Car, color: number) {
    const cell = this.cellMap.get(car.cellId);
    if (!cell) return;
    const circle = this.add.circle(0, 0, 11, color, 1);
    circle.setStrokeStyle(2, 0x1a1a1a, 1);

    const label = this.add.text(0, 0, String(car.carId), {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#0b0f14"
    });
    label.setOrigin(0.5, 0.5);

    const token = this.add.container(cell.pos.x, cell.pos.y, [circle, label]);
    token.setDepth(10);
    token.setSize(24, 24);
    token.setInteractive({ useHandCursor: true });
    this.carTokens.set(car.carId, token);
  }

  private initTurn() {
    this.turn = createTurnState(this.cars);
    const currentId = getCurrentCarId(this.turn);
    this.activeCar = this.cars.find((c) => c.carId === currentId) ?? this.cars[0];
    this.addLog(`Car ${this.activeCar.carId} to play.`);
    this.updateActiveCarVisuals();
  }

  private advanceTurnAndRefresh() {
    advanceTurn(this.turn);
    this.selectNextPlayable();
    this.recomputeTargets();
    this.drawTargets();
  }

  private selectNextPlayable() {
    const maxSkips = Math.max(1, this.cars.length);
    for (let i = 0; i < maxSkips; i++) {
      const currentId = getCurrentCarId(this.turn);
      const car = this.cars.find((c) => c.carId === currentId) ?? this.cars[0];
      if (car.pitTurnsRemaining > 0) {
        car.pitTurnsRemaining -= 1;
        car.state = car.pitTurnsRemaining > 0 ? "PITTING" : "ACTIVE";
        if (car.pitTurnsRemaining === 0) {
          car.pitExitBoost = true;
        }
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
    this.activeCar = this.cars.find((c) => c.carId === currentId) ?? this.cars[0];
    this.addLog(`Car ${this.activeCar.carId} to play.`);
    this.updateActiveCarVisuals();
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
    const maxSteps = this.activeCar.tire === 0 || this.activeCar.fuel === 0 ? 4 : 9;
    const tireRate = this.activeCar.setup.compound === "soft" ? 0.5 : 0.35;
    const fuelRate = 0.45;
    this.validTargets = computeValidTargets(this.track, this.activeCar.cellId, occupied, maxSteps, {
      allowPitExitSkip: this.activeCar.pitExitBoost,
      disallowPitBoxTargets: this.activeCar.pitServiced
    }, {
      tireRate,
      fuelRate,
      setup: this.activeCar.setup
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

  private drawLogPanel() {
    this.gUI.clear();
    this.gUI.fillStyle(0x0f141b, 0.9);
    this.gUI.fillRoundedRect(800, 10, 290, 180, 8);
    this.gUI.lineStyle(1, 0x2a3642, 1);
    this.gUI.strokeRoundedRect(800, 10, 290, 180, 8);
  }

  private addLog(line: string) {
    this.logLines.push(line);
    if (this.logLines.length > 8) this.logLines.shift();
    this.txtLog.setText(this.logLines.join("\n"));
  }

  private createPitModal() {
    const panel = this.add.graphics();
    panel.fillStyle(0x0f141b, 0.98);
    panel.fillRoundedRect(320, 200, 460, 240, 10);
    panel.lineStyle(1, 0x2a3642, 1);
    panel.strokeRoundedRect(320, 200, 460, 240, 10);

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

    const fieldY = 300;
    const lineH = 22;

    const compoundLabel = this.add.text(350, fieldY, "Compound", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#9fb0bf"
    });
    const compoundValue = this.add.text(430, fieldY, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#e6edf3"
    });
    const compoundToggle = this.createModalButton(520, fieldY - 4, "Toggle");
    compoundToggle.setScale(0.85);
    compoundToggle.on("pointerdown", () => {
      if (!this.modalSetup) return;
      this.modalSetup.compound = this.modalSetup.compound === "soft" ? "hard" : "soft";
      this.refreshModalValues();
    });

    const psiLabel = this.add.text(350, fieldY + lineH, "PSI FL/FR/RL/RR", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#9fb0bf"
    });
    const psiValue = this.add.text(350, fieldY + lineH + 16, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#e6edf3"
    });
    const psiMinus = this.createModalButton(520, fieldY + lineH + 10, "-");
    const psiPlus = this.createModalButton(560, fieldY + lineH + 10, "+");
    psiMinus.setScale(0.85);
    psiPlus.setScale(0.85);
    psiMinus.on("pointerdown", () => this.adjustPsi(-1));
    psiPlus.on("pointerdown", () => this.adjustPsi(1));

    const wingLabel = this.add.text(350, fieldY + lineH * 2 + 12, "Wing F/R", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#9fb0bf"
    });
    const wingValue = this.add.text(430, fieldY + lineH * 2 + 12, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#e6edf3"
    });
    const wingMinus = this.createModalButton(520, fieldY + lineH * 2 + 8, "-");
    const wingPlus = this.createModalButton(560, fieldY + lineH * 2 + 8, "+");
    wingMinus.setScale(0.85);
    wingPlus.setScale(0.85);
    wingMinus.on("pointerdown", () => this.adjustWing(-1));
    wingPlus.on("pointerdown", () => this.adjustWing(1));

    this.modalValueTexts = {
      compound: compoundValue,
      psi: psiValue,
      wing: wingValue
    };

    this.modalConfirm = this.createModalButton(360, 405, "Confirm");
    this.modalCancel = this.createModalButton(520, 405, "Cancel");

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

  private openPitModal(cell: TrackCell, origin: { x: number; y: number }, originCellId: string) {
    this.pendingPit = { cell, origin, originCellId };
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
      this.applyPitStop(this.pendingPit.cell);
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

  private applyPitStop(cell: TrackCell) {
    this.activeCar.cellId = cell.id;
    this.activeCar.tire = 100;
    this.activeCar.fuel = 100;
    if (this.modalSetup) {
      this.activeCar.setup = this.modalSetup;
    }
    this.activeCar.state = "PITTING";
    this.activeCar.pitTurnsRemaining = 1;
    this.activeCar.pitExitBoost = false;
    this.activeCar.pitServiced = true;
    this.addLog(`Car ${this.activeCar.carId} pit stop at ${cell.id}.`);
  }

  private applyMoveCosts(info: TargetInfo) {
    this.activeCar.tire = this.clamp01to100(this.activeCar.tire - info.tireCost);
    this.activeCar.fuel = this.clamp01to100(this.activeCar.fuel - info.fuelCost);
  }

  private clamp01to100(value: number) {
    if (value < 0) return 0;
    if (value > 100) return 100;
    return value;
  }

  private refreshModalValues() {
    if (!this.modalSetup) return;
    this.modalValueTexts.compound.setText(this.modalSetup.compound);
    this.modalValueTexts.psi.setText(
      `${this.modalSetup.psi.fl}/${this.modalSetup.psi.fr}/${this.modalSetup.psi.rl}/${this.modalSetup.psi.rr}`
    );
    this.modalValueTexts.wing.setText(`${this.modalSetup.wingFrontDeg}/${this.modalSetup.wingRearDeg}`);
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
      this.add.text(labelCell.pos.x + 10, labelCell.pos.y - 10, `${z}`, {
        fontFamily: "monospace",
        fontSize: "12px",
        color: "#9fb0bf"
      });
    }
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
      return [
        `track: ${this.track.trackId}`,
        `zones: ${this.track.zones}  lanes: ${this.track.lanes}`,
        `hover a cell to inspect it`,
        `click a cell to log next[]`,
        `valid targets: ${this.validTargets.size}`
      ].join("\n");
    }

    const tags = (cell.tags ?? []).join(", ") || "none";
    const targetInfo = this.validTargets.get(cell.id);
    const factors = targetInfo ? this.computeCostFactors(cell.laneIndex) : null;
    const targetLine = targetInfo
      ? `target: d${targetInfo.distance}  tire-${targetInfo.tireCost}  fuel-${targetInfo.fuelCost}${targetInfo.isPitTrigger ? "  PIT" : ""}`
      : null;
    const factorLine = factors
      ? `factors: aero x${factors.aero.toFixed(2)}  psi x${factors.psi.toFixed(2)}  laneT x${factors.laneT.toFixed(2)}  laneF x${factors.laneF.toFixed(2)}`
      : null;
    return [
      `cell: ${cell.id}`,
      `zone: ${cell.zoneIndex}  lane: ${cell.laneIndex}`,
      `tags: ${tags}`,
      `next: ${cell.next.length}`,
      ...(targetLine ? [targetLine] : []),
      ...(factorLine ? [factorLine] : []),
      `valid targets: ${this.validTargets.size}`
    ].join("\n");
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
