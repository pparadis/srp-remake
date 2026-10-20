import type Phaser from 'phaser';
import { textResolution } from '../../hidpi';
import { must } from '../../must';
import {
  bakeFactor,
  ringTexture,
  SELECTED_RING,
  targetLayers,
  type TargetRing
} from '../rendering/baked_textures';

export interface TargetMarker {
  x: number;
  y: number;
  ring: TargetRing;
  cost: string;
}

/**
 * The rings and move costs over the cells a car can reach. Redrawn on every turn change and tap, so nothing is made
 * or destroyed there: the rings are pooled Images of baked textures, the costs pooled Texts that rasterise again
 * only when their number changes.
 */
export class TargetMarkers {
  private readonly rings: Phaser.GameObjects.Image[] = [];
  private readonly costs: Phaser.GameObjects.Text[] = [];
  private selected: Phaser.GameObjects.Image | null = null;

  private readonly scene: Phaser.Scene;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
  }

  /** Shows `markers` (and the picked target's ring, if any); whatever was shown before is hidden or reused. */
  show(markers: readonly TargetMarker[], selected: { x: number; y: number } | null): void {
    markers.forEach((m, i) => {
      const ring = (this.rings[i] ??= this.scene.add
        .image(0, 0, '__DEFAULT')
        .setScale(1 / bakeFactor()));
      const key = ringTexture(this.scene, targetLayers(m.ring));
      if (ring.texture.key !== key) ring.setTexture(key);
      ring.setPosition(m.x, m.y).setVisible(true);

      const cost = (this.costs[i] ??= this.scene.add
        .text(0, 0, '', {
          fontFamily: 'monospace',
          resolution: textResolution(),
          fontSize: '11px',
          color: '#ffffff',
          fontStyle: 'bold',
          stroke: '#0b0f14',
          strokeThickness: 3
        })
        .setOrigin(0.5, 0.5)
        .setDepth(46));
      if (cost.text !== m.cost) cost.setText(m.cost);
      cost.setPosition(m.x, m.y).setVisible(true);
    });
    for (let i = markers.length; i < this.rings.length; i += 1) {
      must(this.rings[i], 'ring').setVisible(false);
      must(this.costs[i], 'cost label').setVisible(false);
    }
    if (selected) {
      // above the other rings, under the trails (depth 4)
      this.selected ??= this.scene.add
        .image(0, 0, ringTexture(this.scene, SELECTED_RING))
        .setScale(1 / bakeFactor())
        .setDepth(1);
      this.selected.setPosition(selected.x, selected.y).setVisible(true);
    } else this.selected?.setVisible(false);
  }

  clear(): void {
    this.show([], null);
  }
}
