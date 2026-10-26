import { renderScale, textResolution } from '../hidpi';
import { UI_FONT } from '../ui_font';
import { FrameGovernor, isFrameLimit } from '../frame_governor';
import { must } from '../must';
import { pinToScreen } from './ui/pin_to_screen';
import Phaser from 'phaser';
import type { TrackData, TrackCell } from '../types/track';
import type { BotLevel, Car } from '../types/car';
import { trackSchema } from '../../validation/track_schema';
import {
  REG_ANIMATE,
  REG_BOT_CARS,
  REG_BOT_LEVEL,
  REG_HUMAN_CARS,
  REG_POSITION,
  REG_RACE_LAPS,
  REG_SANDBOX,
  REG_RULES_VERSION,
  REG_SEED,
  REG_TOTAL_CARS
} from '../constants';
import type { TargetInfo } from '../systems/movement_system';
import type { FeelEvent } from '../systems/feel_events';
import { play } from '../../ui/sound';
import { Confetti } from './ui/confetti';
import { carSprite } from '../systems/spawn_system';
import type { RaceAction } from '../race/race_engine';
import { DEFAULT_RULES_VERSION, type RulesVersion } from '../rules/versions';
import { RaceSession, SERVER_WAIT_MS, type MovePreview } from '../race/race_session';
import { positionAsTest, type CarEdit } from '../race/sandbox';
import type { SandboxCommand } from '../../ui/sandbox_panel';
import { validateTrack } from '../../validation/track_validation';
import { PIT_PANEL, PitModal, type PitModalButton } from './ui/pit_modal';
import { SetupPanel } from '../../ui/setup_panel';
import { DebugButtons } from './ui/debug_buttons';
import { makeButton } from './ui/make_button';
import { applyCarsMovesVisibility } from './ui/cars_moves_visibility';
import { TargetMarkers, type TargetMarker } from './ui/target_markers';
import { badgeTexture, carBodyTexture } from './rendering/baked_textures';
import { drawTrack as drawTrackGraphics, laneColor } from './rendering/track_renderer';
import { easeAngle, headingOf, spriteRotation } from './rendering/heading';
import { GLIDE, glideCap, glideDuration } from './rendering/glide';
import { roadPath } from './rendering/road_path';
import {
  centerOn,
  FITTED,
  panBy,
  pinchTo,
  viewOf,
  wheelTo,
  type Fit,
  type UserView
} from './rendering/camera_view';
import { registerCameraGestures } from './input/register_camera_gestures';
import { carColor } from '../systems/spawn_system';
import { movePath } from '../systems/move_path';
import { registerRaceSceneInputHandlers } from './input/register_race_scene_input_handlers';
import { registerSandboxInputHandlers } from './input/register_sandbox_input_handlers';
import { hudGutters, isCompactHud } from '../../ui/layout';
import type { HudCommand } from '../../ui/hud';
import { validateMoveAttempt } from '../systems/move_validation_system';
import { resolvePlayerDragDrop } from './turns/resolve_player_drag_drop';
import type { buildGameDebugSnapshot } from './debug/game_debug_snapshot';
import type {
  AppliedTurnSummary,
  BackendTurnAction,
  PublicLobby,
  TurnSource
} from '../../net/backend_api';

declare global {
  interface Window {
    __srp?: {
      state: () => ReturnType<typeof buildGameDebugSnapshot>;
      cellScreenPos: (cellId: string) => { x: number; y: number } | null;
      /** Centre of a canvas button (page coordinates): Setup, and the buttons of the pit modal. Null when hidden. */
      uiButtonPos: (name: 'setup' | PitModalButton) => { x: number; y: number } | null;
      /** Where a car token is drawn right now (page coordinates), mid-tween included. */
      tokenScreenPos: (carId: number) => { x: number; y: number } | null;
      /** The rotation of a car's body in radians (Phaser's: 0 = pointing up), mid-drag and mid-glide included. */
      tokenRotation: (carId: number) => number | null;
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
      /** The path being previewed (picked or hovered target), and the trails on the board: cells, as drawn. */
      overlays: () => {
        preview: MovePreview | null;
        trails: Array<{ carId: number; cells: string[]; alpha: number }>;
      };
      /** The camera: the player's zoom (1 = fitted), the camera's own zoom and whether the Fit button shows. */
      view: () => { userZoom: number; zoom: number; fitVisible: boolean };
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

// The baked track is one canvas; iOS refuses one over 16 777 216 px, so keep well under (2x the big oval is 7M).
const MAX_TRACK_TEXTURE_PIXELS = 14_000_000;

export class RaceScene extends Phaser.Scene {
  private static readonly UI = {
    padding: 10,
    bottomButtonYPad: 10
  };
  private static readonly HUD = {
    hoverMaxDist: 18,
    // tap to move: a fingertip's reach in world units (cells are 24 apart; the nearest target in reach wins)
    tapMaxDist: 22
  };
  private track!: TrackData;
  private cellMap!: CellMap;
  // The race, its rules, the turn loop and the HUD data live in the session; the scene only draws them.
  private session!: RaceSession;

  private gTrack!: Phaser.GameObjects.Graphics;
  private trackImage?: Phaser.GameObjects.Image;
  private targetMarkers!: TargetMarkers;
  private gFrame!: Phaser.GameObjects.Graphics;
  private hoverCell: TrackCell | null = null;
  private showForwardIndex = false;
  private forwardIndexLabels: Phaser.GameObjects.Text[] = [];
  private readonly carTokens: Map<number, Phaser.GameObjects.Container> = new Map();
  private readonly activeHalos: Map<number, Phaser.GameObjects.Ellipse> = new Map();
  private activeHaloTween: Phaser.Tweens.Tween | null = null;
  private dragOrigin: { x: number; y: number } | null = null;
  private pendingPit: { cell: TrackCell; origin: { x: number; y: number } } | null = null;
  private pitModal!: PitModal;
  private setupPanel!: SetupPanel;
  private skipButton!: Phaser.GameObjects.Text;
  private setupButton!: Phaser.GameObjects.Text;
  private debugButtons!: DebugButtons;
  private showCarsAndMoves = true;
  private confetti: Confetti | null = null;
  // Set by the e2e hook: no celebration may run over a screenshot.
  private animationsFrozen = false;
  /** Cars whose grid setup panel has opened by itself (rules v3), so Cancel does not bring it back. */
  private readonly offeredSetup = new Set<number>();
  // The cell each car token stands on, or glides to (the board draws from what the session already knows).
  private readonly tokenCell = new Map<number, string>();
  // The camera: what the fit leaves (set by centerTrack), and the player's zoom and pan on top of it.
  private fit: Fit | null = null;
  private userView: UserView = FITTED;
  private viewTween: Phaser.Tweens.Tween | null = null;
  private fitButton!: Phaser.GameObjects.Text;
  // The preview of the move the player is about to make, and the last move of each car (docs/strategy-and-feel.md).
  private gPreview!: Phaser.GameObjects.Graphics;
  private gTow!: Phaser.GameObjects.Graphics;
  /** The followed car's last lap (#135): above the track, under the target rings, the tows and the trails. */
  private gFollowed!: Phaser.GameObjects.Graphics;
  private previewShown: MovePreview | null = null;
  private readonly trails = new Map<number, Phaser.GameObjects.Graphics>();
  // Gliding cars: stop() jumps the token to the end of its glide.
  private readonly glides = new Map<number, { stop: () => void }>();
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
  private readonly onHudCommand = (event: Event) => {
    const command = (event as CustomEvent<HudCommand>).detail;
    if (command?.type === 'confirm-move') this.confirmSelectedTarget();
    else if (command?.type === 'cancel-move') {
      this.session.clearSelection();
      this.drawTargets();
      this.emitHud();
    } else if (command?.type === 'follow-car') {
      this.session.followCar(command.carId);
      this.drawFollowedCar();
      this.emitHud();
    }
  };
  private readonly onSandboxCommand = (event: Event) =>
    this.runSandboxCommand((event as CustomEvent<SandboxCommand>).detail);
  private readonly onBackendLobbyState = (event: Event) => {
    const custom = event as CustomEvent<{ lobby?: PublicLobby; localPlayerId?: string }>;
    const lobby = custom.detail?.lobby;
    if (!lobby) return;
    const localPlayerId =
      typeof custom.detail?.localPlayerId === 'string' ? custom.detail.localPlayerId : null;
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
      typeof detail.lobbyId !== 'string' ||
      typeof detail.playerId !== 'string' ||
      !detail.applied
    ) {
      return;
    }
    this.session.applyTurnApplied(detail.lobbyId, detail.playerId, detail.applied, detail.source);
    this.emitHud();
  };

  constructor() {
    super('RaceScene');
  }

  create() {
    const raw = this.cache.json.get('track');
    const parsed = trackSchema.safeParse(raw);

    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\\n');
      throw new Error(`Invalid track JSON:\\n${msg}`);
    }

    this.track = parsed.data as TrackData;
    const validationErrors = validateTrack(this.track);
    if (validationErrors.length > 0) {
      throw new Error(`Invalid track data:\\n${validationErrors.map((e) => `- ${e}`).join('\\n')}`);
    }
    this.session = new RaceSession(this.track, {
      totalCars: this.registry.get(REG_TOTAL_CARS),
      humanCars: this.registry.get(REG_HUMAN_CARS),
      botCars: this.registry.get(REG_BOT_CARS),
      raceLaps: this.registry.get(REG_RACE_LAPS),
      botLevel: (this.registry.get(REG_BOT_LEVEL) as BotLevel | undefined) ?? 'normal',
      seed: (this.registry.get(REG_SEED) as number | undefined) ?? 0,
      rulesVersion:
        (this.registry.get(REG_RULES_VERSION) as RulesVersion | undefined) ?? DEFAULT_RULES_VERSION,
      sandbox: this.registry.get(REG_SANDBOX) === true
    });
    this.cellMap = this.session.cellMap;

    // The grass is the CSS background of #app behind this transparent canvas (style.css): a 4000x3000 tileSprite
    // was redrawn every frame and took Firefox down to 9 fps (issue #79).
    this.gTrack = this.add.graphics();
    this.gFollowed = this.add.graphics();
    this.targetMarkers = new TargetMarkers(this);
    // above the track, the trails and the target rings; under the cost labels and the cars
    this.gPreview = this.add.graphics().setDepth(8);
    this.gTow = this.add.graphics().setDepth(3); // under the target rings, the preview and the cars
    this.gFrame = this.add.graphics();
    this.drawTrack();
    this.drawFrame();
    this.centerTrack();
    this.setUIFixed();
    this.scale.on('resize', () => {
      this.drawFrame();
      this.layoutUI();
      this.centerTrack();
    });
    // the position first: the tokens are made where the cars are (nothing moves them before the first turn)
    this.loadStartPosition();
    this.spawnCarTokens();
    this.initTurn();
    this.recomputeTargets();
    this.drawTargets();
    this.layoutUI();
    this.createPitModal();
    this.createSkipButton();
    this.createSetupButton();
    this.createFitButton();
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
      window.removeEventListener('srp:toggle-cars-moves', this.onExternalToggleCarsMoves);
      window.removeEventListener('srp:hud-command', this.onHudCommand);
      window.removeEventListener('srp:backend-lobby-state', this.onBackendLobbyState);
      window.removeEventListener('srp:backend-turn-applied', this.onBackendTurnApplied);
      window.removeEventListener('srp:sandbox-command', this.onSandboxCommand);
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, removeWindowListeners);
    this.events.once(Phaser.Scenes.Events.DESTROY, removeWindowListeners);
    // Idle frame rate (#82): full speed while a glide, the camera, confetti or the pit modal moves, or the player acts.
    const loop = this.game.loop;
    if (!isFrameLimit(loop)) throw new Error('Phaser loop has no _limitRate (#82).');
    const governor = new FrameGovernor(loop);
    const stopWatching = governor.watch(window);
    const onUpdate = () => {
      governor.tick(this.isAnimating());
      if (this.session.carsMoving() && this.glides.size === 0) this.settleBoard();
    };
    this.events.on(Phaser.Scenes.Events.UPDATE, onUpdate);
    const stopGoverning = () => {
      stopWatching();
      this.events.off(Phaser.Scenes.Events.UPDATE, onUpdate);
    };
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, stopGoverning);
    this.events.once(Phaser.Scenes.Events.DESTROY, stopGoverning);
    window.addEventListener('srp:toggle-cars-moves', this.onExternalToggleCarsMoves);
    window.addEventListener('srp:hud-command', this.onHudCommand);
    window.addEventListener('srp:backend-lobby-state', this.onBackendLobbyState);
    window.addEventListener('srp:backend-turn-applied', this.onBackendTurnApplied);
    if (this.sandbox) window.addEventListener('srp:sandbox-command', this.onSandboxCommand);

    registerRaceSceneInputHandlers({
      scene: this,
      isRaceFinished: () => this.raceFinished,
      pitModal: { isActive: () => this.modalActive() },
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
        // a developer aid: with the F overlay on (on a phone every tap would copy and log otherwise)
        if (this.showForwardIndex) void this.copyCellId(cellId);
      },
      onTap: (x, y, carId) => this.tapBoard(x, y, carId),
      carIdOfToken: (obj) => this.carIdOfToken(obj),
      toggleForwardIndexOverlay: () => this.toggleForwardIndexOverlay(),
      openPitModal: (cell, origin) => this.openPitModal(cell, origin),
      onMove: (targetCellId) => {
        this.applyLocalAction({ type: 'move', targetCellId });
      },
      onReturn: () => this.glideTo(this.activeCar.carId, this.activeCar.cellId),
      canControlActiveCar: () => this.canLocalControlActiveCar(),
      onUnauthorizedControlAttempt: () => {
        this.addLog('Not your turn/car.');
      },
      isSuspended: () => this.editing,
      hoverMaxDist: RaceScene.HUD.hoverMaxDist,
      dragSnapDist: 18
    });
    // Zoom and pan: pinch, a drag on the empty board, the wheel, a double tap to fit again (camera_view.ts).
    registerCameraGestures({
      scene: this,
      enabled: () => !this.editing && !this.modalActive(),
      onPan: (dx, dy) => {
        this.viewTween?.stop();
        if (this.fit) this.setUserView(panBy(this.fit, this.userView, dx, dy));
      },
      onPinch: (last, now) => {
        this.viewTween?.stop();
        if (this.fit) this.setUserView(pinchTo(this.fit, this.userView, last, now));
      },
      onWheel: (x, y, deltaY) => {
        this.viewTween?.stop();
        if (this.fit) this.setUserView(wheelTo(this.fit, this.userView, x, y, deltaY));
      },
      onDoubleTap: () => {
        if (this.userView.zoom > 1) this.resetView();
      }
    });
    // iOS Safari pinches the whole page with its own gesture events even under touch-action: none; the board owns them
    const stopPageZoom = (event: Event) => event.preventDefault();
    document.addEventListener('gesturestart', stopPageZoom);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () =>
      document.removeEventListener('gesturestart', stopPageZoom)
    );
    this.events.once(Phaser.Scenes.Events.DESTROY, () =>
      document.removeEventListener('gesturestart', stopPageZoom)
    );
    if (this.sandbox) {
      registerSandboxInputHandlers({
        scene: this,
        isEditing: () => this.editing,
        carIdOfToken: (obj) => this.carIdOfToken(obj),
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

    if (import.meta.env.DEV || import.meta.env.MODE === 'test') {
      // e2e hook: read-only state + cell -> page coordinates for real mouse drags
      window.__srp = {
        state: () => this.session.debugSnapshot(),
        status: () => ({
          raceLaps: this.session.raceLaps,
          winnerCarId: this.session.winnerCarId,
          canControl: this.canLocalControlActiveCar() && !this.raceFinished,
          activeOwnerId: this.activeCar.ownerId
        }),
        view: () => ({
          userZoom: this.userView.zoom,
          zoom: this.cameras.main.zoom,
          fitVisible: this.fitButton?.visible ?? false
        }),
        overlays: () => ({
          preview: this.previewShown,
          trails: [...this.trails].map(([carId, g]) => ({
            carId,
            cells: this.session.lastMovePath(carId),
            alpha: g.alpha
          }))
        }),
        freezeAnimations: () => {
          this.activeHaloTween?.stop();
          this.activeHaloTween = null;
          for (const halo of this.activeHalos.values()) halo.setScale(1).setAlpha(1);
          this.confetti?.stop();
          this.confetti = null;
          this.animationsFrozen = true;
          for (const carId of [...this.glides.keys()]) this.finishGlide(carId);
        },
        cellScreenPos: (cellId) => this.cellScreenPos(cellId),
        uiButtonPos: (name) => this.uiButtonScreenPos(name),
        pointerProbe: () => {
          const pointer = this.input.activePointer;
          const hits = this.input.hitTestPointer(pointer);
          const token = this.carTokens.get(this.activeCar.carId);
          const bounds = this.scale.canvasBounds;
          const dom = this.game.canvas.getBoundingClientRect();
          return {
            topCarId: hits[0] ? this.carIdOfToken(hits[0]) : null,
            hits: hits.length,
            draggableCarIds: [...this.carTokens]
              .filter(([, token]) => token.input?.draggable)
              .map(([id]) => id),
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
        },
        tokenRotation: (carId) => {
          const token = this.carTokens.get(carId);
          return token ? (token.first as Phaser.GameObjects.Image).rotation : null;
        }
      };
    }
    // main.ts replays the latest lobby state now that the scene listens for it.
    window.dispatchEvent(new Event('srp:scene-ready'));
  }

  private posOf(cellId: string) {
    return must(this.cellMap.get(cellId), 'cell to draw').pos;
  }

  private carIdOfToken(obj: Phaser.GameObjects.GameObject): number | null {
    return [...this.carTokens].find(([, token]) => token === obj)?.[0] ?? null;
  }

  private spawnCarTokens() {
    this.cars.forEach((car, i) => this.spawnCarToken(car, carSprite(i)));
  }

  private clearCarVisuals() {
    for (const carId of [...this.glides.keys()]) this.finishGlide(carId);
    this.tokenCell.clear();
    for (const trail of this.trails.values()) trail.destroy();
    this.trails.clear();
    this.drawFollowedCar();
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
    // Both pictures are baked once (baked_textures.ts): nothing is rescaled or rasterised per frame.
    const body = this.add
      .image(0, 0, carBodyTexture(this, spriteKey, 15, 28))
      .setDisplaySize(15, 28);
    body.setRotation(spriteRotation(cell, this.cellMap));
    const badge = this.add.image(0, 0, badgeTexture(this, car.carId)).setDisplaySize(12, 12);

    const token = this.add.container(cell.pos.x, cell.pos.y, [body, badge]);
    token.setDepth(50);
    // a finger needs a bigger target than the sprite; the drawing stays the same
    const coarse =
      typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
    token.setSize(coarse ? 40 : 28, coarse ? 30 : 18);
    token.setInteractive({ useHandCursor: true });
    this.carTokens.set(car.carId, token);
    this.tokenCell.set(car.carId, car.cellId);
  }

  private initTurn() {
    this.followedCell = this.session.localCar()?.cellId ?? null;
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

  // The last car has arrived: whoever is on turn may act now (rings, halo, banner, the "your turn" chime).
  private settleBoard() {
    this.session.setCarsMoving(false);
    this.recomputeTargets();
    this.updateActiveCarVisuals();
    this.drawTargets();
    this.updateSkipButtonState();
    this.emitHud();
    this.reactToRace();
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
    this.maybeFollowMyCar();
    if (this.session.takeFinish()) {
      window.dispatchEvent(
        new CustomEvent('srp:race-finished', {
          detail: { winnerCarId: this.session.winnerCarId, recap: this.session.recapInfo() }
        })
      );
    }
  }

  // Toasts, confetti and sounds for what changed since the last render (nothing on the first one).
  private reactToRace() {
    for (const event of this.session.drainFeel()) this.reactTo(event);
  }

  private reactTo(event: FeelEvent) {
    switch (event.type) {
      case 'lap': {
        const text = event.final ? 'Final lap' : `Lap ${event.lap} / ${event.laps}`;
        window.dispatchEvent(
          new CustomEvent('srp:toast', { detail: { text, kind: event.final ? 'final' : 'lap' } })
        );
        play('lap');
        break;
      }
      case 'slingshot':
        window.dispatchEvent(
          new CustomEvent('srp:toast', { detail: { text: 'Slingshot!', kind: 'slingshot' } })
        );
        play('slingshot');
        break;
      case 'draft':
        window.dispatchEvent(
          new CustomEvent('srp:toast', { detail: { text: 'In the tow: less wear', kind: 'draft' } })
        );
        play('draft');
        break;
      case 'slingshotReady':
        window.dispatchEvent(
          new CustomEvent('srp:toast', { detail: { text: 'Slingshot ready', kind: 'slingshot' } })
        );
        play('ready');
        break;
      case 'finish':
        if (!this.animationsFrozen) this.confetti = new Confetti(this);
        play('finish');
        break;
      default:
        play(event.type);
    }
  }

  // Online, the server moves the car: until it answers, the car we just dropped (or tapped) keeps the place and heading
  // of its target cell instead of sliding back to the old one; a tapped car glides there at once.
  private faceDroppedCell(action: RaceAction) {
    if (action.type === 'skip' || action.type === 'setup') return;
    this.glideTo(this.activeCar.carId, action.targetCellId);
  }

  // Cars move at once in the e2e build (specs read where they are), under reduced motion, and in a frozen screenshot.
  private instantMoves(): boolean {
    if (this.animationsFrozen) return true;
    if (import.meta.env.MODE === 'test' && this.registry.get(REG_ANIMATE) !== true) return true;
    return (
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    );
  }

  // Ends a glide now: the car stands on the cell it was gliding to.
  private finishGlide(carId: number) {
    this.glides.get(carId)?.stop();
    this.glides.delete(carId);
  }

  /**
   * Moves a car's token to a cell: along the lane it drove (movePath, round the cars standing where they stood when it
   * moved), turning with the road, in `delayMs` after now. Returns how long the glide takes (0 when it is already there
   * or the move is instant). The token's cell is recorded at once, so a second sync does not glide it again.
   */
  private glideTo(
    carId: number,
    toCellId: string,
    delayMs = 0,
    capMs: number = GLIDE.maxMs
  ): number {
    const token = this.carTokens.get(carId);
    const cell = this.cellMap.get(toCellId);
    if (!token || !cell) return 0;
    this.finishGlide(carId);
    const body = token.first as Phaser.GameObjects.Image;
    const halo = this.activeHalos.get(carId);
    const arrive = () => {
      token.setPosition(cell.pos.x, cell.pos.y);
      halo?.setPosition(cell.pos.x, cell.pos.y);
      body.setRotation(spriteRotation(cell, this.cellMap));
    };
    const fromId = this.tokenCell.get(carId);
    this.tokenCell.set(carId, toCellId);
    const there = token.x === cell.pos.x && token.y === cell.pos.y;
    if (there || this.instantMoves()) {
      arrive();
      if (!there) this.showTrail(carId); // an instant move (reduced motion) still leaves its trail
      return 0;
    }

    // From the cell the token stands on; a token moved by hand (a drag, the sandbox) goes straight from where it is.
    const fromCell = fromId ? this.cellMap.get(fromId) : undefined;
    const onCell = !!fromCell && token.x === fromCell.pos.x && token.y === fromCell.pos.y;
    let ids: string[] = [];
    if (onCell && fromId) {
      const blocked = new Set<string>();
      for (const [otherId, cellId] of this.tokenCell) if (otherId !== carId) blocked.add(cellId);
      ids = movePath({ cellMap: this.cellMap }, fromId, toCellId, blocked);
    }
    const points =
      ids.length >= 2
        ? ids.map((id) => this.posOf(id))
        : [
            { x: token.x, y: token.y },
            { x: cell.pos.x, y: cell.pos.y }
          ];
    const path = roadPath(points);

    const here = new Phaser.Math.Vector2();
    const ahead = new Phaser.Math.Vector2();
    const duration = glideDuration(Math.max(1, points.length - 1), capMs);
    // A token put down by hand (a dropped drag, a refused one going back) has no road under it: it turns from the way it
    // faces to the cell's heading as it settles, instead of facing along the short straight line (#110).
    const handMoved = ids.length < 2;
    const startRotation = body.rotation;
    const endRotation = spriteRotation(cell, this.cellMap);
    const tween = this.tweens.addCounter({
      from: 0,
      to: 1,
      duration,
      delay: delayMs,
      ease: 'Sine.easeInOut',
      // the trail shows when the car sets off, not while it waits for the cars before it
      onStart: () => this.showTrail(carId),
      onUpdate: (counter: Phaser.Tweens.Tween) => {
        const t = counter.getValue() ?? 0;
        path.getPoint(t, here);
        token.setPosition(here.x, here.y);
        halo?.setPosition(here.x, here.y);
        if (handMoved) {
          body.setRotation(easeAngle(startRotation, endRotation, t));
          return;
        }
        // face along the road: the point a little further on (a little back at the very end)
        const a = Math.min(t, 0.97);
        path.getPoint(a, here);
        path.getPoint(a + 0.03, ahead);
        body.setRotation(Math.atan2(ahead.y - here.y, ahead.x - here.x) + Math.PI / 2);
      },
      onComplete: () => {
        this.glides.delete(carId);
        arrive();
        this.drawTow(); // the tows were hidden while cars glided
      }
    });
    this.glides.set(carId, {
      stop: () => {
        tween.stop();
        arrive();
      }
    });
    return duration;
  }

  // Puts every token where its car is: cars that moved glide there one after another, in the order they moved.
  private syncTokens() {
    const held = this.session.heldCarId();
    const order = this.session.drainMoves();
    const moving: Car[] = [];
    for (const car of this.cars) {
      const cell = this.cellMap.get(car.cellId);
      const token = this.carTokens.get(car.carId);
      if (!cell || !token || car.carId === held) continue;
      if (token.x === cell.pos.x && token.y === cell.pos.y) {
        // already there (a drag-drop, a sandbox edit): nothing to animate
        this.tokenCell.set(car.carId, car.cellId);
        if (!this.glides.has(car.carId)) {
          (token.first as Phaser.GameObjects.Image).setRotation(spriteRotation(cell, this.cellMap));
        }
      } else if (this.tokenCell.get(car.carId) !== car.cellId) {
        moving.push(car);
      }
    }
    const rank = (carId: number) => {
      const at = order.indexOf(carId);
      return at < 0 ? order.length : at;
    };
    moving.sort((a, b) => rank(a.carId) - rank(b.carId));
    const cap = glideCap(moving.length);
    let delay = 0;
    for (const car of moving) delay += this.glideTo(car.carId, car.cellId, delay, cap);
    // The race is already ahead of the board: nobody acts until the last car has arrived (see settleBoard).
    if (this.glides.size > 0) this.session.setCarsMoving(true);
    // a car that moved but did not glide (a drop is its own motion; instant moves) still leaves its trail
    for (const carId of order) {
      if (!moving.some((car) => car.carId === carId)) this.showTrail(carId);
    }
    this.drawFollowedCar();
  }

  // The followed car's last lap (#135): the road it drove as a faint white line (a car colour can be as dark as the
  // asphalt), a dot in its colour where each move ended (a yellow ring at a pit stop), and a ring round the car.
  private drawFollowedCar() {
    const g = this.gFollowed;
    g.clear();
    const carId = this.session.followed;
    const car = this.cars.find((c) => c.carId === carId);
    if (!car || !this.showCarsAndMoves) return;
    const moves = this.session.followedMoves();
    g.lineStyle(3, 0xffffff, 0.35);
    for (const move of moves) {
      if (move.path.length >= 2) roadPath(move.path.map((id) => this.posOf(id))).draw(g, 64);
    }
    const color = Phaser.Display.Color.HexStringToColor(carColor(this.cars.indexOf(car))).color;
    for (const move of moves) {
      const end = this.posOf(must(move.path.at(-1), 'last cell of a move'));
      g.fillStyle(color, 0.9);
      g.fillCircle(end.x, end.y, 3.5);
      g.lineStyle(move.pit ? 2 : 1, move.pit ? 0xffe066 : 0x0b0f14, 0.9);
      g.strokeCircle(end.x, end.y, move.pit ? 6 : 3.5);
    }
    const at = this.posOf(car.cellId);
    g.lineStyle(2, 0xffffff, 0.8);
    g.strokeCircle(at.x, at.y, 17);
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
        const canControlActive =
          this.editing || (this.canLocalControlActiveCar() && !this.raceFinished);
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
        ease: 'Sine.easeInOut'
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
    this.drawPreview();
    this.drawTow();
    if (!this.showCarsAndMoves || this.session.carsMoving()) return this.targetMarkers.clear();
    const markers: TargetMarker[] = [];
    for (const [cellId, info] of this.validTargets) {
      const cell = this.cellMap.get(cellId);
      if (!cell) continue;
      // Slingshot: the draft makes this move cheaper (or puts it in reach at all): a gold ring, doubled when only the
      // slingshot puts it in reach. A squeeze target is never a slingshot (squeeze only exists when no main-lane target does).
      // Risk: the move leaves a resource under 20% (thin ring) or empty (thick ring).
      const left = this.session.resourcesAfter(info);
      const least = Math.min(left.tire, left.fuel);
      markers.push({
        x: cell.pos.x,
        y: cell.pos.y,
        ring: {
          color: info.isPitTrigger ? 0xffe066 : laneColor(cell.laneIndex),
          squeeze: Boolean(info.squeezePassed),
          slingshot: Boolean(info.slingshot),
          slingshotOnly: Boolean(info.slingshotOnly),
          tuck: !info.isPitTrigger && this.session.endsTucked(cellId),
          risk: info.isPitTrigger || least >= 20 ? 'none' : least <= 0 ? 'empty' : 'low'
        },
        cost: String(this.session.moveSpendOf(info, cell.laneIndex))
      });
    }
    // tap to move: the picked target, waiting for Move here
    const selected = this.session.selectedTarget();
    const selectedCell = selected && this.cellMap.get(selected.cellId);
    this.targetMarkers.show(markers, selectedCell ? selectedCell.pos : null);
  }

  // The tows: a few faint streaks from each car whose last move ended tucked in behind a car, along its lane for as far
  // as that car, while it is still there: blue while it counts, gold when the slingshot is open. Every car's, not only
  // the player's. Redrawn on a turn change; hidden while cars glide.
  private drawTow() {
    this.gTow.clear();
    if (!this.showCarsAndMoves || this.glides.size > 0) return;
    for (const link of this.session.draftLinks()) {
      const car = this.cars.find((c) => c.carId === link.carId);
      const start = car && this.cellMap.get(car.cellId);
      if (!start) continue;
      const points = [start.pos];
      for (let cur = start, i = 0; i < link.gap; i += 1) {
        const next = cur.next
          .map((id) => this.cellMap.get(id))
          .find((c) => c && c.laneIndex === cur.laneIndex);
        if (!next) break;
        points.push(next.pos);
        cur = next;
      }
      if (points.length < 2) continue;
      const heading = headingOf(start, this.cellMap);
      this.gTow.lineStyle(2, link.ready ? 0xffd166 : 0x7fb4ff, 0.6);
      for (const offset of [-4, 0, 4]) {
        const line = points.map((p) => ({
          x: p.x - heading.y * offset,
          y: p.y + heading.x * offset
        }));
        roadPath(line).draw(this.gTow, 24);
      }
    }
  }

  // The path of the move about to be made (the picked target, else the one under the pointer or the dragged car), as a
  // line along the road in the lane's colour. Redrawn when the target or the hover changes, never per frame.
  private drawPreview() {
    this.gPreview.clear();
    this.previewShown = null;
    if (!this.showCarsAndMoves) return;
    const preview = this.session.previewFor(this.hoverCell?.id ?? null);
    if (!preview || preview.cells.length < 2) return;
    const target = this.cellMap.get(preview.cellId);
    if (!target) return;
    this.previewShown = preview;
    const color =
      preview.kind === 'pit'
        ? 0xffe066
        : preview.kind === 'slingshot'
          ? 0xffd166
          : preview.kind === 'squeeze'
            ? 0xffb020
            : laneColor(target.laneIndex);
    const path = roadPath(preview.cells.map((id) => this.posOf(id)));
    this.gPreview.lineStyle(7, 0x0b0f14, 0.35); // a dark edge, so it reads on the asphalt and on the kerbs
    path.draw(this.gPreview, 64);
    this.gPreview.lineStyle(4, color, 0.9);
    path.draw(this.gPreview, 64);
  }

  // The last move of a car as a thin line in its colour: drawn when it sets off, then fading to a faint line that stays
  // until the car moves again ("what happened while I was waiting"). Not in the e2e build (screenshots); under reduced
  // motion it is drawn faint and does not fade.
  /**
   * Something on the canvas is moving that needs full frame rate. The active car's halo pulse and a trail's slow fade
   * run all the time (or for seconds), so they do not count: they just look a little stepped at the idle rate.
   */
  private isAnimating(): boolean {
    const ambient = new Set<unknown>([this.activeHaloTween, ...this.trails.values()]);
    // a killed tween is destroyed (targets null) but stays listed until the manager's next preUpdate
    const moving = this.tweens
      .getTweens()
      .some(
        (tween) =>
          !tween.isDestroyed() &&
          tween !== this.activeHaloTween &&
          !tween.targets.some((t) => ambient.has(t))
      );
    return moving || this.confetti?.active === true || this.modalActive();
  }

  private showTrail(carId: number) {
    if (import.meta.env.MODE === 'test' && this.registry.get(REG_ANIMATE) !== true) return;
    const cells = this.session.lastMovePath(carId);
    if (cells.length < 2) return;
    let trail = this.trails.get(carId);
    if (!trail) {
      trail = this.add.graphics().setDepth(4);
      this.trails.set(carId, trail);
    }
    this.tweens.killTweensOf(trail);
    const index = Math.max(
      0,
      this.cars.findIndex((car) => car.carId === carId)
    );
    trail.clear();
    trail.lineStyle(3, Phaser.Display.Color.HexStringToColor(carColor(index)).color, 1);
    roadPath(cells.map((id) => this.posOf(id))).draw(trail, 64);
    trail.setVisible(this.showCarsAndMoves);
    const reduced =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || this.animationsFrozen) {
      trail.setAlpha(0.35);
      return;
    }
    trail.setAlpha(0.75);
    this.tweens.add({ targets: trail, alpha: 0.22, duration: 4500, ease: 'Quad.easeOut' });
  }

  /**
   * A tap on the board (a press and release without a drag) picks the nearest target in reach, or drops the pick. With
   * no target in reach, a tap on a car follows it, or stops following it (#135): not the car the player may drag now.
   */
  private tapBoard(x: number, y: number, tappedCarId: number | null) {
    if (this.editing || this.modalActive() || !this.showCarsAndMoves) return;
    const canMove = this.session.localCanControl();
    let best: { id: string; d: number } | null = null;
    for (const cellId of canMove ? this.validTargets.keys() : []) {
      const cell = this.cellMap.get(cellId);
      if (!cell) continue;
      const d = Math.hypot(cell.pos.x - x, cell.pos.y - y);
      if (d <= RaceScene.HUD.tapMaxDist && (!best || d < best.d)) best = { id: cellId, d };
    }
    if (best) this.session.selectTarget(best.id);
    else {
      this.session.clearSelection();
      if (tappedCarId !== null && !(canMove && tappedCarId === this.activeCar.carId)) {
        this.session.followCar(tappedCarId);
        this.drawFollowedCar();
      }
    }
    this.drawTargets();
    this.emitHud();
  }

  /** Move here: the picked target goes through the same path as a drop (validation, pit modal, engine or server). */
  private confirmSelectedTarget() {
    const selected = this.session.selectedTarget();
    const cell = selected ? this.cellMap.get(selected.cellId) : undefined;
    const token = this.getActiveToken();
    this.session.clearSelection();
    if (!cell || !token || this.modalActive()) {
      this.drawTargets();
      this.emitHud();
      return;
    }
    const activeCar = this.activeCar;
    resolvePlayerDragDrop({
      activeCar,
      token,
      origin: { x: token.x, y: token.y },
      nearestCell: cell,
      validation: validateMoveAttempt(
        activeCar,
        this.cellMap.get(activeCar.cellId) ?? null,
        cell,
        this.validTargets,
        this.session.localCanControl()
      ),
      cellMap: this.cellMap,
      activeHalo: this.activeHalos.get(activeCar.carId) ?? null,
      onOpenPitModal: (pitCell, origin) => this.openPitModal(pitCell, origin),
      onMove: (targetCellId) => this.applyLocalAction({ type: 'move', targetCellId }),
      glideMove: true
    });
    this.drawTargets();
    this.emitHud();
  }

  private drawFrame() {
    this.gFrame.clear();
    const s = renderScale(); // a 1 CSS px line
    this.gFrame.lineStyle(s, 0x2a3642, 0.8);
    this.gFrame.strokeRect(s, s, this.scale.width - 2 * s, this.scale.height - 2 * s);
  }

  private setUIFixed() {
    const fixed = [this.gFrame, this.skipButton, this.setupButton, this.fitButton].filter(Boolean);
    // zoomed in, a car can pass under the buttons: they stay on top of the board (the pit modal is above them, 100)
    for (const button of [this.skipButton, this.setupButton, this.fitButton]) button?.setDepth(80);
    for (const obj of fixed) pinToScreen(obj);
    if (this.pitModal) {
      this.pitModal.setFixed();
    }
    if (this.debugButtons) this.debugButtons.setFixed();
  }

  // Fit the track between the DOM HUD panels (columns on a desktop, a top bar on a phone) and above the bottom buttons;
  // the player's zoom and pan (pinch, drag on the empty board, wheel) sit on top of that fit (camera_view.ts).
  private centerTrack() {
    const xs = this.track.cells.map((c) => c.pos.x);
    const ys = this.track.cells.map((c) => c.pos.y);
    if (xs.length === 0 || ys.length === 0) return;
    const pad = 20; // curbs
    const [minX, maxX] = [Math.min(...xs) - pad, Math.max(...xs) + pad];
    const [minY, maxY] = [Math.min(...ys) - pad, Math.max(...ys) + pad];
    // The canvas has `s` pixels per CSS pixel (hidpi.ts): sizes in CSS pixels are multiplied by it, and the camera
    // zoom is in canvas pixels per world unit.
    const s = renderScale();
    const w = this.scale.width;
    const h = this.scale.height;
    const hud = document.getElementById('hud');
    const css = hud
      ? hudGutters(hud, this.game.canvas.getBoundingClientRect())
      : { left: 0, right: 0, top: 0 };
    const gl = css.left * s;
    const gr = css.right * s;
    const top = css.top * s;
    // Room for the Skip button (and, on a desktop, the debug buttons) under the track: on a phone Skip is 29 px tall,
    // 10 px up.
    const bottom = (isCompactHud() ? 44 : 50) * s;
    const zoom = Phaser.Math.Clamp(
      Math.min((w - gl - gr) / (maxX - minX), (h - top - bottom) / (maxY - minY)),
      0.4 * s,
      s
    );
    this.fit = {
      zoom,
      bx: (minX + maxX) / 2,
      by: (minY + maxY) / 2,
      bw: maxX - minX,
      bh: maxY - minY,
      w,
      h,
      gl,
      gr,
      top,
      bottom,
      scale: s
    };
    this.applyView();
  }

  // The camera for the fit and the player's view; also lays the fixed UI out again (it counter-scales by the zoom).
  private applyView() {
    if (!this.fit) return;
    const view = viewOf(this.fit, this.userView);
    this.userView = view.user;
    const cam = this.cameras.main;
    cam.setZoom(view.zoom);
    cam.centerOn(view.cx, view.cy);
    // The camera's matrix and world view are rebuilt before the next render; pointer.worldX and cellScreenPos read them
    // now (a tap right after a pinch), so bring them up to date.
    cam.preRender();
    this.layoutUI();
    this.updateFitButton();
  }

  private setUserView(user: UserView) {
    this.userView = user;
    this.applyView();
  }

  // Back to the fitted track, easing there (instantly when motion is not wanted).
  private resetView() {
    this.viewTween?.stop();
    this.viewTween = null;
    if (this.instantMoves() || !this.fit) {
      this.setUserView(FITTED);
      return;
    }
    const from = { ...this.userView };
    this.viewTween = this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 260,
      ease: 'Sine.easeInOut',
      onUpdate: (counter: Phaser.Tweens.Tween) => {
        const t = counter.getValue() ?? 1;
        this.setUserView({
          zoom: from.zoom + (1 - from.zoom) * t,
          px: from.px * (1 - t),
          py: from.py * (1 - t)
        });
      },
      onComplete: () => this.setUserView(FITTED)
    });
  }

  // Solo has no "turn becomes yours" moment (the bots play inside the refresh): the player's car is on turn again after
  // it has moved, so follow it when it is on turn and its cell is not the one it was last centred on.
  private followedCell: string | null = null;
  private maybeFollowMyCar() {
    const car = this.session.localCar();
    if (
      !car ||
      this.raceFinished ||
      !this.session.localCanControl() ||
      car.cellId === this.followedCell
    ) {
      return;
    }
    this.followedCell = car.cellId;
    this.followMyCar();
  }

  // When it is the player's turn again and they have zoomed in, bring their car to the middle of the free area.
  private followMyCar() {
    if (!this.fit || this.userView.zoom <= 1) return;
    const car = this.session.localCar();
    const cell = car ? this.cellMap.get(car.cellId) : undefined;
    if (!cell) return;
    this.viewTween?.stop();
    const target = centerOn(this.fit, this.userView, cell.pos.x, cell.pos.y);
    const from = { ...this.userView };
    if (this.instantMoves()) {
      this.setUserView(target);
      return;
    }
    this.viewTween = this.tweens.addCounter({
      from: 0,
      to: 1,
      duration: 320,
      ease: 'Sine.easeInOut',
      onUpdate: (counter: Phaser.Tweens.Tween) => {
        const t = counter.getValue() ?? 1;
        this.setUserView({
          zoom: from.zoom,
          px: from.px + (target.px - from.px) * t,
          py: from.py + (target.py - from.py) * t
        });
      }
    });
  }

  // The Fit button only shows while the player has zoomed in.
  private updateFitButton() {
    this.fitButton?.setVisible(this.userView.zoom > 1.01 && !this.modalActive());
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
        fontFamily: UI_FONT,
        resolution: textResolution(),
        fontSize: '10px',
        color: '#e6edf3'
      });
      label.setDepth(20);
      this.forwardIndexLabels.push(label);
    }
  }

  private layoutUI() {
    const w = this.scale.width;
    const h = this.scale.height;
    const ui = RaceScene.UI;
    const s = renderScale(); // canvas pixels per CSS pixel (hidpi.ts)
    if (this.setupButton) {
      this.setupButton.setPosition(w / 2 - 90 * s, h - ui.bottomButtonYPad * s);
    }
    if (this.skipButton) {
      this.skipButton.setPosition(w / 2, h - ui.bottomButtonYPad * s);
    }
    if (this.fitButton) {
      this.fitButton.setPosition(w / 2 + 90 * s, h - ui.bottomButtonYPad * s);
    }
    if (this.debugButtons) {
      this.debugButtons.layout(w, h, ui.padding * s, ui.bottomButtonYPad * s);
      // developer tools: no room for them on a phone, and their F / C / E companions need a keyboard anyway
      for (const t of this.debugButtons.getTexts()) t.setVisible(!isCompactHud());
    }
    // Fixed (scrollFactor 0) objects are zoomed with the camera; undo that so the UI keeps its size (`s`: one CSS
    // pixel per unit, `k` undoes the camera zoom on positions).
    const z = this.cameras.main.zoom;
    const k = 1 / z;
    const texts = [
      this.skipButton,
      this.setupButton,
      this.fitButton,
      ...(this.debugButtons?.getTexts() ?? [])
    ].filter(Boolean);
    for (const t of texts) {
      if (t) t.setScale(k * s).setPosition(w / 2 + (t.x - w / 2) * k, h / 2 + (t.y - h / 2) * k);
    }
    const origin = { x: (w / 2) * (1 - k), y: (h / 2) * (1 - k) };
    this.gFrame?.setScale(k).setPosition(origin.x, origin.y);
    // The pit modal: centred, and scaled down when the screen is smaller than the panel (a phone in landscape).
    const fit = Math.min(s, (w - 16 * s) / PIT_PANEL.width, (h - 16 * s) / PIT_PANEL.height);
    const sc = k * fit;
    this.pitModal
      ?.getContainer()
      .setScale(sc)
      .setPosition(
        w / 2 - (PIT_PANEL.x + PIT_PANEL.width / 2) * sc,
        h / 2 - (PIT_PANEL.y + PIT_PANEL.height / 2) * sc
      );
  }

  private createPitModal() {
    this.pitModal = new PitModal(this);
    // the grid setup menu is DOM (#159), over the HUD and scrolling on a short screen
    this.setupPanel = new SetupPanel(document.body);
    const dispose = () => this.setupPanel.destroy();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, dispose);
    this.events.once(Phaser.Scenes.Events.DESTROY, dispose);
  }

  /** A modal that takes the board's input is open: the pit stop (canvas) or the grid setup (DOM). */
  private modalActive(): boolean {
    return this.pitModal?.isActive() === true || this.setupPanel?.isActive() === true;
  }

  private createSkipButton() {
    this.skipButton = makeButton(this, 'Skip turn', {
      fontSize: '14px',
      originX: 0.5,
      originY: 1,
      onClick: () => this.skipTurn()
    });
    this.updateSkipButtonState();
    this.layoutUI();
    this.setUIFixed();
  }

  private createSetupButton() {
    this.setupButton = makeButton(this, 'Setup', {
      fontSize: '14px',
      originX: 0.5,
      originY: 1,
      onClick: () => this.openGridSetup()
    });
    this.updateSkipButtonState();
    this.layoutUI();
    this.setUIFixed();
  }

  // Back to the fitted track: only shown once the player has zoomed in (double-tap on the board does the same).
  private createFitButton() {
    this.fitButton = makeButton(this, 'Fit', {
      fontSize: '14px',
      originX: 0.5,
      originY: 1,
      onClick: () => this.resetView()
    });
    this.fitButton.setVisible(false);
    this.layoutUI();
    this.setUIFixed();
  }

  // Before a car's first turn: compound and wing, once and free (the car keeps the turn).
  private openGridSetup() {
    if (!this.session.canSetup() || this.modalActive()) return;
    const features = this.session.setupFeatures();
    this.setupPanel.open({
      setup: this.activeCar.setup,
      stints: (setup) => this.session.pitStints(setup),
      pace: (setup) => this.session.paceOf(setup),
      features,
      fuelNote: (setup) => this.session.fuelNote(setup),
      ...(features.fuelLoad ? { suggest: () => this.session.suggestedSetup() } : {}),
      onConfirm: (setup) => {
        this.setupPanel.close();
        this.applyLocalAction({ type: 'setup', setup });
      },
      onCancel: () => this.setupPanel.close()
    });
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
    const button = document.getElementById('toggleCarsMovesBtn') as HTMLButtonElement | null;
    if (!button) return;
    button.textContent = this.showCarsAndMoves ? 'Cars+moves: ON' : 'Cars+moves: OFF';
  }

  private applyCarsAndMovesVisibility() {
    for (const trail of this.trails.values()) trail.setVisible(this.showCarsAndMoves);
    this.drawFollowedCar();
    applyCarsMovesVisibility({
      showCarsAndMoves: this.showCarsAndMoves,
      activeHaloTween: this.activeHaloTween,
      setActiveHaloTween: (tween) => {
        this.activeHaloTween = tween;
      },
      clearTargets: () => this.targetMarkers.clear(),
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
    if (this.setupButton) {
      const canSetup = this.session.canSetup();
      this.setupButton.setVisible(canSetup);
      if (canSetup) this.setupButton.setInteractive({ useHandCursor: true });
      else this.setupButton.disableInteractive();
    }
    // a tick later: this runs while the scene is still being made, before the panel has been laid out
    this.time.delayedCall(0, () => this.offerGridSetup());
  }

  // Rules v3: the setup is a real decision (compound, fuel), so the panel opens by itself on the player's first turn,
  // once per car, prefilled; Cancel keeps the dealt setup and the Setup button stays.
  private offerGridSetup() {
    if (!this.pitModal) return;
    if (!this.session.setupFeatures().fuelLoad || !this.session.canSetup()) return;
    const carId = this.activeCar.carId;
    if (this.offeredSetup.has(carId) || this.modalActive()) return;
    this.offeredSetup.add(carId);
    this.openGridSetup();
  }

  private async copyDebugSnapshot() {
    const snapshot = this.session.debugSnapshot();
    const payload = JSON.stringify(snapshot, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      this.addLog('Copied debug snapshot to clipboard.');
    } catch {
      this.addLog('Clipboard failed. Check console for snapshot.');
      console.log('Debug snapshot:', payload);
    }
  }

  private async copyBotDecisionSnapshot() {
    const snapshot = this.session.botDecisionSnapshot();
    const payload = JSON.stringify(snapshot, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      this.addLog('Copied bot decision snapshot to clipboard.');
    } catch {
      this.addLog('Clipboard failed. Check console for bot snapshot.');
      console.log('Bot decision snapshot:', payload);
    }
  }

  private async copyShortBotDecisionSnapshot() {
    const snapshot = this.session.botDecisionSnapshot(true);
    const payload = JSON.stringify(snapshot, null, 2);
    try {
      await navigator.clipboard.writeText(payload);
      this.addLog('Copied short bot decision snapshot to clipboard.');
    } catch {
      this.addLog('Clipboard failed. Check console for short bot snapshot.');
      console.log('Short bot decision snapshot:', payload);
    }
  }

  private async copyCellId(cellId: string) {
    try {
      await navigator.clipboard.writeText(cellId);
      this.addLog(`Copied cell id: ${cellId}`);
    } catch {
      this.addLog(`Clipboard failed for cell id: ${cellId}`);
      console.log('Cell id:', cellId);
    }
  }

  private skipTurn() {
    if (this.raceFinished) return;
    if (!this.canLocalControlActiveCar()) {
      this.addLog('Not your turn/car.');
      return;
    }
    if (this.validTargets.size !== 0 || this.activeCar.state !== 'ACTIVE') return;
    this.applyLocalAction({ type: 'skip' });
  }

  private openPitModal(cell: TrackCell, origin: { x: number; y: number }) {
    this.pendingPit = { cell, origin };
    const token = this.getActiveToken();
    if (token) token.disableInteractive();
    const features = this.session.setupFeatures();
    this.pitModal.open({
      setup: this.activeCar.setup,
      stints: (setup) => this.session.pitStints(setup),
      pace: (setup) => this.session.paceOf(setup),
      features,
      fuelNote: (setup) => this.session.fuelNote(setup),
      ...(features.fuelLoad ? { suggest: () => this.session.suggestedSetup() } : {}),
      bodyLines: [
        `Drop on PIT_BOX: ${cell.id}`,
        `Setup will be applied.`,
        features.fuelLoad
          ? `Fresh tires; fuel topped up to the load.`
          : `Tires and fuel refilled to 100.`,
        `Pit penalty: lose 1 turn.`
      ],
      onConfirm: (setup) => {
        if (!this.pendingPit) return;
        const targetCellId = this.pendingPit.cell.id;
        this.closePitModal();
        this.applyLocalAction({ type: 'pit', targetCellId, setup });
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
      new CustomEvent<BackendTurnAction>('srp:local-turn-action', { detail: action })
    );
  }

  private getActiveToken(): Phaser.GameObjects.Container | null {
    return this.carTokens.get(this.activeCar.carId) ?? null;
  }

  private drawTrack() {
    const xs = this.track.cells.map((c) => c.pos.x);
    const ys = this.track.cells.map((c) => c.pos.y);
    const w = Math.ceil(Math.max(...xs) + 100);
    const h = Math.ceil(Math.max(...ys) + 100);
    // A bigger track at 3x would pass the canvas limit of iOS (about 16M px): a little less sharp, not blank.
    const k = Math.min(renderScale(), Math.sqrt(MAX_TRACK_TEXTURE_PIXELS / (w * h)));
    drawTrackGraphics({
      graphics: this.gTrack,
      track: this.track,
      cellMap: this.cellMap,
      showForwardIndex: this.showForwardIndex,
      renderForwardIndexOverlay: () => this.renderForwardIndexOverlay(),
      scale: k
    });
    // Bake into a texture: a Graphics object is re-tessellated every frame, the static track is not worth that.
    // At `renderScale()` texture pixels per unit and shown at 1 / k, so `?hidpi` is sharp (it was upscaled from 1x).
    const key = 'track-baked';
    this.trackImage?.destroy();
    if (this.textures.exists(key)) this.textures.remove(key);
    this.gTrack.generateTexture(key, Math.ceil(w * k), Math.ceil(h * k));
    this.gTrack.clear();
    this.trackImage = this.add
      .image(0, 0, key)
      .setOrigin(0, 0)
      .setDepth(-5)
      .setScale(1 / k);
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

  // Centre of a canvas button in page coordinates, or null while it is not on screen. The buttons are fixed
  // (scrollFactor 0) and zoomed with the camera around its centre.
  private uiButtonScreenPos(name: 'setup' | PitModalButton): { x: number; y: number } | null {
    const button = name === 'setup' ? this.setupButton : this.pitModal.button(name);
    if (!button || !button.visible || (name !== 'setup' && !this.pitModal.isActive())) return null;
    const b = button.getBounds();
    const cam = this.cameras.main;
    const rect = this.game.canvas.getBoundingClientRect();
    const cx = cam.width / 2;
    const cy = cam.height / 2;
    const canvasX = (b.centerX - cx) * cam.zoom + cx;
    const canvasY = (b.centerY - cy) * cam.zoom + cy;
    return {
      x: rect.left + canvasX * (rect.width / this.scale.width),
      y: rect.top + canvasY * (rect.height / this.scale.height)
    };
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
    this.drawPreview();
    this.emitHud();
  }

  // One plain snapshot for the DOM HUD (src/ui/hud.ts); sent after every change it shows.
  private emitHud() {
    this.updateFitButton();
    const snapshot = this.session.hudSnapshot({
      hoverCell: this.hoverCell,
      showCarsAndMoves: this.showCarsAndMoves,
      showForwardIndex: this.showForwardIndex,
      cellScreenPos: (cellId) => this.cellScreenPos(cellId)
    });
    if (!snapshot) return;
    window.dispatchEvent(new CustomEvent('srp:hud', { detail: snapshot }));
    if (this.sandbox) {
      window.dispatchEvent(
        new CustomEvent('srp:sandbox', { detail: this.session.sandboxSnapshot() })
      );
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
      case 'edit':
        this.sandboxEdit(command.carId, command.edit);
        break;
      case 'select':
        this.sandboxSelect(command.carId);
        break;
      case 'mode':
        this.setEditing(command.editing);
        break;
      case 'copy-test':
        void this.copyText(
          positionAsTest(this.session.ctx, this.session.race),
          'Copied the position as a vitest case.'
        );
        break;
      case 'copy-link': {
        const { cars, activeCarId } = this.session.debugSnapshot();
        const pos = encodeURIComponent(btoa(JSON.stringify({ activeCarId, cars })));
        // the position reproduces only under its own rules: the link carries them (the menu's Rules starts on it)
        const version = this.session.race.rulesVersion ?? DEFAULT_RULES_VERSION;
        const rules = version === DEFAULT_RULES_VERSION ? '' : `&rules=${version}`;
        const url = `${window.location.origin}${import.meta.env.BASE_URL}?sandbox&seed=${this.session.race.seed}${rules}&pos=${pos}`;
        void this.copyText(url, 'Copied the sandbox link (open it, then Quick race).');
        break;
      }
      case 'load':
        this.applyPosition(command.text);
        this.refreshAfterTurn();
        break;
      default:
        command satisfies never; // a new command that is not handled above fails to compile
    }
  }

  private async copyText(text: string, done: string) {
    try {
      await navigator.clipboard.writeText(text);
      this.addLog(done);
    } catch {
      this.addLog('Clipboard failed. Check the console.');
      console.log(text);
    }
  }
}
