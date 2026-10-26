import Phaser from 'phaser';
import { BootScene } from './scenes/boot_scene';
import { RaceScene } from './scenes/race_scene';
import { keepCanvasBoundsFresh } from './canvas_bounds';
import { keepGameSizeInSync } from './game_size';
import { FRAME_RATES, TEST_FPS } from './frame_governor';
import { renderScale, setHidpi } from './hidpi';
import {
  REG_BOT_CARS,
  REG_ANIMATE,
  REG_BOT_LEVEL,
  REG_HUMAN_CARS,
  REG_POSITION,
  REG_RACE_LAPS,
  REG_SANDBOX,
  REG_RULES_VERSION,
  REG_SEED,
  REG_TOTAL_CARS,
  REG_TRACK_ID
} from './constants';
import { DEFAULT_TRACK_ID } from './track_ids';
import { DEFAULT_RULES_VERSION, type RulesVersion } from './rules/versions';
import type { BotLevel } from './types/car';

interface GameOptions {
  // The board (public/tracks/<trackId>.json); the first one when omitted.
  trackId?: string;
  totalCars: number;
  humanCars: number;
  botCars: number;
  raceLaps: number;
  botLevel?: BotLevel;
  // Race seed (bot personalities, grid); 0 = neutral baseline.
  seed?: number;
  // Movement rules of a solo race (src/game/rules/versions.ts); the default when omitted. Online races play the default.
  rulesVersion?: RulesVersion;
  // Solo dev tool (`?sandbox`): start in edit mode, optionally from a "Copy debug" snapshot (JSON text).
  sandbox?: boolean;
  position?: string;
  // WebGL unless `canvas` (#232)
  renderer?: 'canvas' | 'webgl';
  // `?hidpi`: draw the canvas at the screen's pixel density (hidpi.ts); main.ts turns it on unless `?hidpi=0`
  hidpi?: boolean;
  // `?anim`: glide the cars in a test build too (they move at once there, so the specs read where cars are)
  animate?: boolean;
}

const isTestBuild = import.meta.env.MODE === 'test';

export function startGame(parent: HTMLElement, options: GameOptions) {
  setHidpi(options.hidpi ?? false);
  const scale = renderScale();
  const box = parent.getBoundingClientRect();
  const config: Phaser.Types.Core.GameConfig = {
    // WebGL by default (#232); `?renderer=canvas` is the fallback. Software WebGL burns far more CPU than Canvas
    // (tools/cpuProbe.mjs), so a machine without a GPU should pick Canvas.
    type: options.renderer === 'canvas' ? Phaser.CANVAS : Phaser.WEBGL,
    // A frame limit, so the loop can skip frames: the race scene's FrameGovernor moves it between the idle rate and
    // full speed (#82). The e2e build keeps a low cap for the load of many headless pages; tweens use delta time.
    fps: isTestBuild ? { target: TEST_FPS, limit: TEST_FPS } : { limit: FRAME_RATES.idle },
    parent,
    // The grass is the CSS background of the container (#app in style.css), drawn by the browser instead of the game.
    transparent: true,
    scene: [BootScene, RaceScene],
    ...(scale === 1
      ? {
          width: 1600,
          height: 900,
          scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH }
        }
      : {
          // `?hidpi` (hidpi.ts): the canvas has `scale` times the container's pixels and is shown at its size
          width: Math.floor(box.width * scale) || 1600,
          height: Math.floor(box.height * scale) || 900,
          scale: { mode: Phaser.Scale.NONE, zoom: 1 / scale }
        })
  };

  const game = new Phaser.Game(config);
  keepCanvasBoundsFresh(game, Phaser.Core.Events.DESTROY);
  keepGameSizeInSync(game, parent, scale, Phaser.Core.Events.DESTROY);
  game.registry.set(REG_TRACK_ID, options.trackId ?? DEFAULT_TRACK_ID);
  game.registry.set(REG_TOTAL_CARS, options.totalCars);
  game.registry.set(REG_HUMAN_CARS, options.humanCars);
  game.registry.set(REG_BOT_CARS, options.botCars);
  game.registry.set(REG_RACE_LAPS, options.raceLaps);
  game.registry.set(REG_BOT_LEVEL, options.botLevel ?? 'normal');
  game.registry.set(REG_SEED, options.seed ?? 0);
  game.registry.set(REG_RULES_VERSION, options.rulesVersion ?? DEFAULT_RULES_VERSION);
  game.registry.set(REG_SANDBOX, options.sandbox ?? false);
  game.registry.set(REG_POSITION, options.position ?? null);
  game.registry.set(REG_ANIMATE, options.animate ?? false);
  return game;
}
