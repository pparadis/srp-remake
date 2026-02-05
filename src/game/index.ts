import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { RaceScene } from "./scenes/RaceScene";
import { REG_PLAYER_COUNT } from "./constants";

export interface GameOptions {
  playerCount?: number;
}

export function startGame(parent: HTMLElement, options: GameOptions = {}) {
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
  game.registry.set(REG_PLAYER_COUNT, options.playerCount ?? 1);
  return game;
}
