import Phaser from "phaser";
import type { TrackData, TrackCell } from "../types/track";
import type { BotLevel, Car } from "../types/car";
import { trackSchema } from "../../validation/trackSchema";
import {
  REG_BOT_CARS,
  REG_BOT_LEVEL,
  REG_HUMAN_CARS,
  REG_POSITION,
  REG_RACE_LAPS,
  REG_SANDBOX,
  REG_SEED,
  REG_TOTAL_CARS
} from "../constants";
import type { TargetInfo } from "../systems/movementSystem";
import type { FeelEvent } from "../systems/feelEvents";
import { play } from "../../ui/sound";
import { Confetti } from "./ui/Confetti";
import { carSprite } from "../systems/spawnSystem";
import type { RaceAction } from "../race/raceEngine";
import { RaceSession, SERVER_WAIT_MS } from "../race/raceSession";
import { positionAsTest, type CarEdit } from "../race/sandbox";
import type { SandboxCommand } from "../../ui/sandboxPanel";
import { validateTrack } from "../../validation/trackValidation";
import { PIT_PANEL, PitModal } from "./ui/PitModal";
import { DebugButtons } from "./ui/DebugButtons";
import { makeButton } from "./ui/makeButton";
import { applyCarsMovesVisibility } from "./ui/carsMovesVisibility";
import { drawTrack as drawTrackGraphics, laneColor } from "./rendering/trackRenderer";
import { spriteRotation } from "./rendering/heading";
import { registerRaceSceneInputHandlers } from "./input/registerRaceSceneInputHandlers";
import { registerSandboxInputHandlers } from "./input/registerSandboxInputHandlers";
import { hudGutters, isCompactHud } from "../../ui/layout";
import type { buildGameDebugSnapshot } from "./debug/gameDebugSnapshot";
import type { AppliedTurnSummary, BackendTurnAction, PublicLobby, TurnSource } from "../../net/backendApi";

declare global {
  interface Window {
    __srp?: {
      state: () => ReturnType<typeof buildGameDebugSnapshot>;
      cellScreenPos: (cellId: string) => { x: number; y: number } | null;
      /** Where a car token is drawn right now (page coordinates), mid-tween included. */
      tokenScreenPos: (carId: number) => { x: number; y: number } | null;
      /** What Phaser's own hit test finds under the pointer: a drag needs the active car's token on top and draggable. */
      pointerProbe: () => {
        topCarId: number | null;
        hits: number;
        draggableCarIds: number[];
        activeCarId: number;
        /**
         * Where Phaser thinks the canvas is vs where the browser draws it: a gap offsets every pointer hit. Phaser
         * re-checks this every 500 ms, so a gap that lasts points at something else holding the bounds.
         */
        canvas: { phaser: number[]; dom: number[] };
        /** Where Phaser last saw the mouse (canvas pixels, then world): a press elsewhere hits nothing. */
        pointer: number[];
        /** The active car's token: world position, hit area size, visible, input enabled. */
        token: { at: number[]; hitArea: number[]; visible: boolean; enabled: boolean } | null;
      };
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
  private track!: TrackData;
  private cellMap!: CellMap;
  // The race, its rules, the turn loop and the HUD data live in the session; the scene only draws them.
  private session!: RaceSession;

  private gTrack!: Phaser.GameObjects.Graphics;
  private trackImage?: Phaser.GameObjects.Image;
  private gTargets!: Phaser.GameObjects.Graphics;
  private gFrame!: Phaser.GameObjects.Graphics;
  private hoverCell: TrackCell | null = null;
  private showForwardIndex = false;
  private forwardIndexLabels: Phaser.GameObjects.Text[] = [];
  private carTokens: Map<number, Phaser.GameObjects.Container> = new Map();
  private activeHalos: Map<number, Phaser.GameObjects.Ellipse> = new Map();
  private activeHaloTween: Phaser.Tweens.Tween | null = null;
  private targetCostLabels: Phaser.GameObjects.Text[] = [];
  private dragOrigin: { x: number; y: number } | null = null;
  private pendingPit: { cell: TrackCell; origin: { x: number; y: number } } | null = null;
  private pitModal!: PitModal;
  private skipButton!: Phaser.GameObjects.Text;
  private debugButtons!: DebugButtons;
  private showCarsAndMoves = true;
  private confetti: Confetti | null = null;
  // Set by the e2e hook: no celebration may run over a screenshot.
  private animationsFrozen = false;
  private get cars(): Car[] {
    return this.session.cars;
  }
  private get raceFinished(): boolean {
    return this.session.finished;
  }
  private get activeCar(): Car {
    return this.session.activeCar;
  }
  private get validTargets(): Map<string, TargetInfo> {
    return this.session.validTargets;
  }
  // Sandbox (`?sandbox`, solo): in edit mode every car can be dragged anywhere and the bots wait.
  private get sandbox(): boolean {
    return this.session.sandbox;
  }
  private get editing(): boolean {
    return this.session.editing;
  }
  private readonly onExternalToggleCarsMoves = () => {
    this.showCarsAndMoves = !this.showCarsAndMoves;
    this.updateExternalToggleLabel();
    this.applyCarsAndMovesVisibility();
  };
  private readonly onSandboxCommand = (event: Event) =>
    this.runSandboxCommand((event as CustomEvent<SandboxCommand>).detail);
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
    this.session.applyTurnApplied(detail.lobbyId, detail.playerId, detail.applied, detail.source);
    this.emitHud();
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
    this.session = new RaceSession(this.track, {
      totalCars: this.registry.get(REG_TOTAL_CARS),
      humanCars: this.registry.get(REG_HUMAN_CARS),
      botCars: this.registry.get(REG_BOT_CARS),
      raceLaps: this.registry.get(REG_RACE_LAPS),
      botLevel: (this.registry.get(REG_BOT_LEVEL) as BotLevel | undefined) ?? "normal",
      seed: (this.registry.get(REG_SEED) as number | undefined) ?? 0,
      sandbox: this.registry.get(REG_SANDBOX) === true
    });
    this.cellMap = this.session.cellMap;

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
    this.spawnCarTokens();
    this.loadStartPosition();
    this.initTurn();
    this.recomputeTargets();
    this.drawTargets();
    this.layoutUI();
    this.createPitModal();
    this.createSkipButton();
    this.createDebugButtons();
    this.emitHud();
    this.centerTrack(); // the HUD has its content now: fit the track to the space it really leaves
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
      window.removeEventListener("srp:sandbox-command", this.onSandboxCommand);
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, removeWindowListeners);
    this.events.once(Phaser.Scenes.Events.DESTROY, removeWindowListeners);
    window.addEventListener("srp:toggle-cars-moves", this.onExternalToggleCarsMoves);
    window.addEventListener("srp:backend-lobby-state", this.onBackendLobbyState);
    window.addEventListener("srp:backend-turn-applied", this.onBackendTurnApplied);
    if (this.sandbox) window.addEventListener("srp:sandbox-command", this.onSandboxCommand);

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
      isSuspended: () => this.editing,
      hoverMaxDist: RaceScene.HUD.hoverMaxDist,
      dragSnapDist: 18
    });
    if (this.sandbox) {
      registerSandboxInputHandlers({
        scene: this,
        isEditing: () => this.editing,
        carIdOfToken: (obj) => [...this.carTokens].find(([, token]) => token === obj)?.[0] ?? null,
        moveToken: (carId, x, y) => {
          this.carTokens.get(carId)?.setPosition(x, y);
          this.activeHalos.get(carId)?.setPosition(x, y);
        },
        findNearestCell: (x, y, maxDist) => this.findNearestCell(x, y, maxDist),
        onSelect: (carId) => this.sandboxSelect(carId),
        onDrop: (carId, cell) => this.sandboxDrop(carId, cell),
        onToggleEditing: () => this.setEditing(!this.editing),
        snapDist: 18
      });
    }

    if (import.meta.env.DEV || import.meta.env.MODE === "test") {
      // e2e hook: read-only state + cell -> page coordinates for real mouse drags
      window.__srp = {
        state: () => this.session.debugSnapshot(),
        status: () => ({
          raceLaps: this.session.raceLaps,
          winnerCarId: this.session.winnerCarId,
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
        pointerProbe: () => {
          const pointer = this.input.activePointer;
          const hits = this.input.hitTestPointer(pointer);
          const token = this.carTokens.get(this.activeCar.carId);
          const bounds = this.scale.canvasBounds;
          const dom = this.game.canvas.getBoundingClientRect();
          const carIdOf = (obj: Phaser.GameObjects.GameObject) =>
            [...this.carTokens].find(([, token]) => token === obj)?.[0] ?? null;
          return {
            topCarId: hits[0] ? carIdOf(hits[0]) : null,
            hits: hits.length,
            draggableCarIds: [...this.carTokens].filter(([, token]) => token.input?.draggable).map(([id]) => id),
            activeCarId: this.activeCar.carId,
            canvas: {
              phaser: [bounds.x, bounds.y, bounds.width, bounds.height].map(Math.round),
              dom: [dom.x, dom.y, dom.width, dom.height].map(Math.round)
            },
            pointer: [pointer.x, pointer.y, pointer.worldX, pointer.worldY].map(Math.round),
            token: token
              ? {
                  at: [token.x, token.y].map(Math.round),
                  hitArea: [token.input?.hitArea?.width ?? -1, token.input?.hitArea?.height ?? -1],
                  visible: token.visible,
                  enabled: token.input?.enabled ?? false
                }
              : null
          };
        },
        tokenScreenPos: (carId) => {
          const token = this.carTokens.get(carId);
          return token ? this.worldToScreen(token.x, token.y) : null;
        }
      };
    }
    // main.ts replays the latest lobby state now that the scene listens for it.
    window.dispatchEvent(new Event("srp:scene-ready"));
  }

  private spawnCarTokens() {
    this.cars.forEach((car, i) => this.spawnCarToken(car, carSprite(i)));
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

  private canLocalControlActiveCar(): boolean {
    return this.session.canControlActiveCar();
  }

  // Multiplayer: the server owns the race. The session takes its snapshot; redraw from it.
  private applyBackendLobbyState(lobby: PublicLobby, localPlayerId: string | null) {
    const { respawned, applied } = this.session.applyServerState(lobby, localPlayerId);
    if (respawned) {
      this.clearCarVisuals();
      this.spawnCarTokens();
      this.updateActiveCarVisuals();
      this.updateSkipButtonState();
      this.drawTargets();
      this.emitHud();
    }
    if (!applied) return;
    if (this.carTokens.size !== this.cars.length) {
      this.clearCarVisuals();
      this.spawnCarTokens();
    }
    this.refreshAfterTurn();
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

  // Applies the active car's action through the session (solo: the engine, which rejects anything invalid and
  // leaves the state untouched; online: the server, whose race.state redraws the board). Either way, re-render.
  private applyLocalAction(action: RaceAction): boolean {
    const ok = this.session.applyLocal(action);
    if (this.session.online) {
      this.scheduleServerWaitRelease();
      this.emitLocalTurnAction(action);
      this.faceDroppedCell(action);
    }
    this.refreshAfterTurn();
    return ok;
  }

  // Unlocks input by itself if the server never answers.
  private scheduleServerWaitRelease() {
    this.time.delayedCall(SERVER_WAIT_MS, () => {
      if (this.session.releaseServerWait()) this.refreshAfterTurn();
    });
  }

  private refreshAfterTurn() {
    this.processBotsUntilHuman();
    this.syncTokens();
    this.updateActiveCarVisuals();
    this.recomputeTargets();
    this.drawTargets();
    this.updateSkipButtonState();
    this.emitHud();
    this.reactToRace();
    if (this.session.takeFinish()) {
      window.dispatchEvent(
        new CustomEvent("srp:race-finished", { detail: { winnerCarId: this.session.winnerCarId } })
      );
    }
  }

  // Toasts, confetti and sounds for what changed since the last render (nothing on the first one).
  private reactToRace() {
    for (const event of this.session.drainFeel()) this.reactTo(event);
  }

  private reactTo(event: FeelEvent) {
    switch (event.type) {
      case "lap": {
        const text = event.final ? "Final lap" : `Lap ${event.lap} / ${event.laps}`;
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
    const held = this.session.heldCarId();
    for (const car of this.cars) {
      const cell = this.cellMap.get(car.cellId);
      if (!cell) continue;
      const token = this.carTokens.get(car.carId);
      if (!token) continue;
      if (car.carId === held) continue;
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
    // Whoever is active now (human or bot) must be rendered as such, also when this
    // ran from recomputeTargets() after the turn-end refresh.
    if (this.session.runBots() > 0) {
      this.syncTokens();
      this.updateActiveCarVisuals();
    }
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
        const canControlActive = this.editing || (this.canLocalControlActiveCar() && !this.raceFinished);
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
        token.setAlpha(this.editing ? 1 : 0.6);
        token.setScale(1);
        this.input.setDraggable(token, this.editing);
        if (halo) {
          halo.setVisible(false);
          halo.setScale(1);
          halo.setAlpha(1);
        }
      }
    }

    const activeHalo = this.activeHalos.get(this.activeCar.carId);
    if (activeHalo && (this.editing || (this.canLocalControlActiveCar() && !this.raceFinished))) {
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
    if (this.session.recomputeTargets() > 0) {
      this.syncTokens();
      this.updateActiveCarVisuals();
    }
    this.updateSkipButtonState();
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
      if (info.squeezePassed) this.strokeDashedRing(cell.pos.x, cell.pos.y, 13, 0xffb020);
      // Risk: the move leaves a resource under 20% (thin ring) or empty (thick ring).
      const left = this.session.resourcesAfter(info);
      if (!info.isPitTrigger && Math.min(left.tire, left.fuel) < 20) {
        this.gTargets.lineStyle(Math.min(left.tire, left.fuel) <= 0 ? 4 : 2, 0xff4d4d, 1);
        this.gTargets.strokeCircle(cell.pos.x, cell.pos.y, 14);
      }

      const costLabel = this.add.text(
        cell.pos.x,
        cell.pos.y,
        String(this.session.moveSpendOf(info, cell.laneIndex)),
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

  // Squeeze targets: dashed amber ring (Phaser graphics has no dash style, so draw arcs).
  private strokeDashedRing(x: number, y: number, radius: number, color: number) {
    this.gTargets.lineStyle(3, color, 1);
    const dashes = 10;
    for (let i = 0; i < dashes; i += 1) {
      const a0 = (i / dashes) * Math.PI * 2;
      this.gTargets.beginPath();
      this.gTargets.arc(x, y, radius, a0, a0 + (Math.PI * 2) / dashes / 2);
      this.gTargets.strokePath();
    }
  }

  private clearTargetCostLabels() {
    for (const label of this.targetCostLabels) {
      label.destroy();
    }
    this.targetCostLabels = [];
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
    if (this.debugButtons) this.debugButtons.setFixed();
  }

  // Fit the track between the DOM HUD panels (columns on a desktop, a top bar on a phone) and above the bottom buttons.
  private centerTrack() {
    const xs = this.track.cells.map((c) => c.pos.x);
    const ys = this.track.cells.map((c) => c.pos.y);
    if (xs.length === 0 || ys.length === 0) return;
    const pad = 20; // curbs
    const [minX, maxX] = [Math.min(...xs) - pad, Math.max(...xs) + pad];
    const [minY, maxY] = [Math.min(...ys) - pad, Math.max(...ys) + pad];
    const w = this.scale.width;
    const h = this.scale.height;
    const hud = document.getElementById("hud");
    const { left: gl, right: gr, top } = hud
      ? hudGutters(hud, this.game.canvas.getBoundingClientRect())
      : { left: 0, right: 0, top: 0 };
    // Room for the Skip button (and, on a desktop, the debug buttons) under the track.
    const bottom = isCompactHud() ? 32 : 50;
    const zoom = Phaser.Math.Clamp(
      Math.min((w - gl - gr) / (maxX - minX), (h - top - bottom) / (maxY - minY)),
      0.4,
      1
    );
    const cam = this.cameras.main;
    cam.setZoom(zoom);
    cam.centerOn((minX + maxX) / 2 - (gl - gr) / 2 / zoom, (minY + maxY) / 2 + (bottom - top) / 2 / zoom);
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
    this.session.addLog(line);
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
      // developer tools: no room for them on a phone, and their F / C / E companions need a keyboard anyway
      for (const t of this.debugButtons.getTexts()) t.setVisible(!isCompactHud());
    }
    // Fixed (scrollFactor 0) objects are zoomed with the camera; undo that so the UI keeps its size.
    const z = this.cameras.main.zoom;
    const k = 1 / z;
    const texts = [this.skipButton, ...(this.debugButtons?.getTexts() ?? [])];
    for (const t of texts) {
      if (t) t.setScale(k).setPosition(w / 2 + (t.x - w / 2) * k, h / 2 + (t.y - h / 2) * k);
    }
    const origin = { x: (w / 2) * (1 - k), y: (h / 2) * (1 - k) };
    this.gFrame?.setScale(k).setPosition(origin.x, origin.y);
    // The pit modal: centred, and scaled down when the screen is smaller than the panel (a phone in landscape).
    const fit = Math.min(1, (w - 16) / PIT_PANEL.width, (h - 16) / PIT_PANEL.height);
    const s = k * fit;
    this.pitModal
      ?.getContainer()
      .setScale(s)
      .setPosition(w / 2 - (PIT_PANEL.x + PIT_PANEL.width / 2) * s, h / 2 - (PIT_PANEL.y + PIT_PANEL.height / 2) * s);
  }

  private createPitModal() {
    this.pitModal = new PitModal(this);
  }

  private createSkipButton() {
    this.skipButton = makeButton(this, "Skip turn", {
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
    const canSkip = this.session.canSkip();
    this.skipButton.setAlpha(canSkip ? 1 : 0.4);
    if (canSkip) this.skipButton.setInteractive({ useHandCursor: true });
    else this.skipButton.disableInteractive();
  }

  private async copyDebugSnapshot() {
    const snapshot = this.session.debugSnapshot();
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
    const snapshot = this.session.botDecisionSnapshot();
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
    const snapshot = this.session.botDecisionSnapshot(true);
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
      stints: (setup) => this.session.pitStints(setup),
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

  // One plain snapshot for the DOM HUD (src/ui/hud.ts); sent after every change it shows.
  private emitHud() {
    const snapshot = this.session.hudSnapshot({
      hoverCell: this.hoverCell,
      showCarsAndMoves: this.showCarsAndMoves,
      showForwardIndex: this.showForwardIndex,
      cellScreenPos: (cellId) => this.cellScreenPos(cellId)
    });
    if (!snapshot) return;
    window.dispatchEvent(new CustomEvent("srp:hud", { detail: snapshot }));
    if (this.sandbox) {
      window.dispatchEvent(new CustomEvent("srp:sandbox", { detail: this.session.sandboxSnapshot() }));
    }
  }

  // ---- sandbox (`?sandbox`) ------------------------------------------------------------------------------------

  private sandboxEdit(carId: number, edit: CarEdit) {
    this.session.sandboxEdit(carId, edit);
    this.refreshAfterTurn();
  }

  // A drop on a free cell moves the car, on another car swaps them; away from any cell the car goes back.
  private sandboxDrop(carId: number, cell: TrackCell | null) {
    this.session.sandboxDrop(carId, cell?.id ?? null);
    this.refreshAfterTurn();
  }

  private sandboxSelect(carId: number) {
    if (this.session.sandboxSelect(carId)) this.refreshAfterTurn();
  }

  private setEditing(editing: boolean) {
    this.session.setEditing(editing);
    this.refreshAfterTurn();
  }

  // Puts a "Copy debug" snapshot in place (the caller redraws), and nothing celebrates it.
  private applyPosition(text: string) {
    this.session.loadPosition(text);
    this.session.resetFeel();
  }

  private loadStartPosition() {
    const position = this.registry.get(REG_POSITION) as string | null | undefined;
    if (this.sandbox && position) this.applyPosition(position);
  }

  private runSandboxCommand(command: SandboxCommand) {
    switch (command.type) {
      case "edit":
        this.sandboxEdit(command.carId, command.edit);
        break;
      case "select":
        this.sandboxSelect(command.carId);
        break;
      case "mode":
        this.setEditing(command.editing);
        break;
      case "copy-test":
        void this.copyText(positionAsTest(this.session.ctx, this.session.race), "Copied the position as a vitest case.");
        break;
      case "copy-link": {
        const { cars, activeCarId } = this.session.debugSnapshot();
        const pos = encodeURIComponent(btoa(JSON.stringify({ activeCarId, cars })));
        const url = `${window.location.origin}${import.meta.env.BASE_URL}?sandbox&seed=${this.session.race.seed}&pos=${pos}`;
        void this.copyText(url, "Copied the sandbox link (open it, then Quick race).");
        break;
      }
      case "load":
        this.applyPosition(command.text);
        this.refreshAfterTurn();
        break;
    }
  }

  private async copyText(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.addLog(done);
    } catch {
      this.addLog("Clipboard failed. Check the console.");
      console.log(text);
    }
  }
}
