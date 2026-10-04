import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { RaceScene } from "./scenes/RaceScene";
import { REG_BOT_CARS, REG_HUMAN_CARS, REG_RACE_LAPS, REG_TOTAL_CARS } from "./constants";

export interface GameOptions {
  totalCars: number;
  humanCars: number;
  botCars: number;
  raceLaps: number;
}

export function startGame(parent: HTMLElement, options: GameOptions) {
  const config: Phaser.Types.Core.GameConfig = {
    type: Phaser.AUTO,
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
  return game;
}
