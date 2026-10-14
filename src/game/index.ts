import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { RaceScene } from "./scenes/RaceScene";
import { keepCanvasBoundsFresh } from "./canvasBounds";
import { keepGameSizeInSync } from "./gameSize";
import { renderScale, setHidpi } from "./hidpi";
import {
  REG_BOT_CARS,
  REG_ANIMATE,
  REG_BOT_LEVEL,
  REG_HUMAN_CARS,
  REG_POSITION,
  REG_RACE_LAPS,
  REG_SANDBOX,
  REG_SEED,
  REG_TOTAL_CARS
} from "./constants";
import type { BotLevel } from "./types/car";

interface GameOptions {
  totalCars: number;
  humanCars: number;
  botCars: number;
  raceLaps: number;
  botLevel?: BotLevel;
  // Race seed (bot personalities, grid); 0 = neutral baseline.
  seed?: number;
  // Solo dev tool (`?sandbox`): start in edit mode, optionally from a "Copy debug" snapshot (JSON text).
  sandbox?: boolean;
  position?: string;
  // `?hidpi`: draw the canvas at the screen's pixel density (hidpi.ts); off by default while it is tried on iPhone
  hidpi?: boolean;
  // `?anim`: glide the cars in a test build too (they move at once there, so the specs read where cars are)
  animate?: boolean;
}

const isTestBuild = import.meta.env.MODE === "test";
const TEST_FPS = 10;

export function startGame(parent: HTMLElement, options: GameOptions) {
  setHidpi(options.hidpi ?? false);
  const scale = renderScale();
  const box = parent.getBoundingClientRect();
  const config: Phaser.Types.Core.GameConfig = {
    // Canvas on purpose: a turn-based board (lines, a few sprites, text) needs no WebGL, and software WebGL
    // burned many CPU cores per page (tools/cpuProbe.mjs: 125.6 s vs 8.8 s of CPU for the same race).
    type: Phaser.CANVAS,
    // e2e build only: still lowers the load of many headless pages; tweens use delta time, so they finish.
    ...(isTestBuild ? { fps: { target: TEST_FPS, limit: TEST_FPS } } : {}),
    parent,
    // The grass is the CSS background of the container (#app in style.css), drawn by the browser instead of the game.
    transparent: true,
    scene: [BootScene, RaceScene],
    ...(scale === 1
      ? { width: 1600, height: 900, scale: { mode: Phaser.Scale.RESIZE, autoCenter: Phaser.Scale.CENTER_BOTH } }
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
  game.registry.set(REG_TOTAL_CARS, options.totalCars);
  game.registry.set(REG_HUMAN_CARS, options.humanCars);
  game.registry.set(REG_BOT_CARS, options.botCars);
  game.registry.set(REG_RACE_LAPS, options.raceLaps);
  game.registry.set(REG_BOT_LEVEL, options.botLevel ?? "normal");
  game.registry.set(REG_SEED, options.seed ?? 0);
  game.registry.set(REG_SANDBOX, options.sandbox ?? false);
  game.registry.set(REG_POSITION, options.position ?? null);
  game.registry.set(REG_ANIMATE, options.animate ?? false);
  return game;
}
