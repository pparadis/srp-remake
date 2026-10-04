import Phaser from "phaser";

export class BootScene extends Phaser.Scene {
  constructor() {
    super("BootScene");
  }

  preload() {
    this.load.json("track", `${import.meta.env.BASE_URL}tracks/oval16_3lanes.json`);
  }

  create() {
    this.scene.start("RaceScene");
  }
}
