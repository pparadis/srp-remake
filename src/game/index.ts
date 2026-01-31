import Phaser from "phaser";
import { BootScene } from "./scenes/BootScene";
import { RaceScene } from "./scenes/RaceScene";

export function startGame(parent: HTMLElement) {
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

  return new Phaser.Game(config);
}
