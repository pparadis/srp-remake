import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { RaceScene } from "./scenes/RaceScene";
import {
  REG_BOT_CARS,
  REG_BOT_LEVEL,
  REG_HUMAN_CARS,
  REG_RACE_LAPS,
  REG_TOTAL_CARS
} from "./constants";
import type { BotLevel } from "./types/car";

export interface GameOptions {
  totalCars: number;
  humanCars: number;
  botCars: number;
  raceLaps: number;
  botLevel?: BotLevel;
}

const isTestBuild = import.meta.env.MODE === "test";
const TEST_FPS = 10;

export function startGame(parent: HTMLElement, options: GameOptions) {
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
    // e2e build only: the game is turn-based and software WebGL burns many CPU cores per page at 60 fps.
    // Tweens use delta time, so they still finish; see tools/cpuProbe.mjs for the measurements.
    ...(isTestBuild ? { fps: { target: TEST_FPS, limit: TEST_FPS } } : {}),
    parent,
    width: 1600,
    height: 900,
    backgroundColor: "#0b0f14",
    scene: [BootScene, RaceScene],
    scale: {
      mode: Phaser.Scale.RESIZE,
      autoCenter: Phaser.Scale.CENTER_BOTH
    }
  };
  (config as { resolution?: number }).resolution = window.devicePixelRatio ?? 1;

  const game = new Phaser.Game(config);
  game.registry.set(REG_TOTAL_CARS, options.totalCars);
  game.registry.set(REG_HUMAN_CARS, options.humanCars);
  game.registry.set(REG_BOT_CARS, options.botCars);
  game.registry.set(REG_RACE_LAPS, options.raceLaps);
  game.registry.set(REG_BOT_LEVEL, options.botLevel ?? "normal");
  return game;
}
