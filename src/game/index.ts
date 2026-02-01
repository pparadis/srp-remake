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
    width: 1100,
    height: 700,
    backgroundColor: "#0b0f14",
    scene: [BootScene, RaceScene],
    scale: {
      mode: Phaser.Scale.FIT,
      autoCenter: Phaser.Scale.CENTER_BOTH
    }
  };

  const game = new Phaser.Game(config);
  game.registry.set(REG_PLAYER_COUNT, options.playerCount ?? 1);
  return game;
}
