import Phaser from "phaser";
import { CAR_SPRITES } from "../systems/spawnSystem";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("BootScene");
  }

  preload() {
    const assets = `${import.meta.env.BASE_URL}assets/kenney/`;
    for (const key of CAR_SPRITES) this.load.image(key, `${assets}${key}.png`);
    this.load.image("grass", `${assets}grass.png`);
    this.load.json("track", `${import.meta.env.BASE_URL}tracks/oval16_3lanes.json`);
  }

  create() {
    this.scene.start("RaceScene");
  }
}
