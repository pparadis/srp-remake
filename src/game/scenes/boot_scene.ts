import Phaser from 'phaser';
import { REG_TRACK_ID } from '../constants';
import { DEFAULT_TRACK_ID } from '../track_ids';
import { CAR_SPRITES } from '../systems/spawn_system';

export class BootScene extends Phaser.Scene {
  constructor() {
    super('BootScene');
  }

  preload() {
    const assets = `${import.meta.env.BASE_URL}assets/kenney/`;
    for (const key of CAR_SPRITES) this.load.image(key, `${assets}${key}.png`);
    const trackId = this.registry.get(REG_TRACK_ID) ?? DEFAULT_TRACK_ID;
    this.load.json(
      'track',
      `${import.meta.env.BASE_URL}tracks/${encodeURIComponent(trackId)}.json`
    );
  }

  create() {
    this.scene.start('RaceScene');
  }
}
