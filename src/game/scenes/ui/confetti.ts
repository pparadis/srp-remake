import Phaser from 'phaser';
import { renderScale } from '../../hidpi';
import { swatchTexture } from '../rendering/baked_textures';

interface Flip {
  angle: number;
  spin: number;
}

const COLORS = [0xffe066, 0xff5a5a, 0x4cd964, 0x4da3ff, 0xffffff, 0xff9f43];
const FADE_MS = 600;

/** One burst of confetti in screen space, gone after `lifeMs`: one particle emitter of a white swatch, tinted per piece. */
export class Confetti {
  private readonly emitter: Phaser.GameObjects.Particles.ParticleEmitter;
  private done = false;

  constructor(scene: Phaser.Scene, lifeMs = 3500, count = 120) {
    const { width, height } = scene.scale;
    const k = 1 / scene.cameras.main.zoom;
    const px = renderScale(); // canvas pixels per CSS pixel: the pieces keep their size on screen
    const key = swatchTexture(scene, 0xffffff);
    const swatch = scene.textures.getFrame(key).width;
    // the paper flip: each piece's width follows |cos| of its own angle (pooled particles are re-set on emit)
    const flips = new WeakMap<Phaser.GameObjects.Particles.Particle, Flip>();
    this.emitter = scene.add
      .particles(0, 0, key, {
        emitting: false,
        lifespan: lifeMs,
        x: { min: 0, max: width },
        y: { min: -20 * px - height * 0.4, max: -20 * px },
        speedX: { min: -60 * px, max: 60 * px },
        speedY: { min: 120 * px, max: 340 * px },
        tint: COLORS,
        scaleY: { min: (5 * px) / swatch, max: (10 * px) / swatch },
        scaleX: {
          onEmit: (p) => {
            if (p) {
              flips.set(p, { angle: Math.random() * Math.PI, spin: (Math.random() - 0.5) * 8 });
            }
            return 0;
          },
          onUpdate: (p, _key, t) => {
            const flip = flips.get(p);
            const angle = flip ? flip.angle + (flip.spin * t * lifeMs) / 1000 : 0;
            return p.scaleY * (0.4 + Math.abs(Math.cos(angle)));
          }
        },
        alpha: {
          onEmit: () => 1,
          onUpdate: (_p, _key, t) => Math.min(1, ((1 - t) * lifeMs) / FADE_MS)
        }
      })
      // Fixed objects are zoomed with the camera; undo that so the burst covers the screen.
      .setPosition((width / 2) * (1 - k), (height / 2) * (1 - k))
      .setScrollFactor(0)
      .setDepth(90)
      .setScale(k);
    this.emitter.once(Phaser.GameObjects.Particles.Events.COMPLETE, () => this.stop());
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.stop());
    this.emitter.explode(count);
  }

  /** True while the burst is falling. */
  get active() {
    return !this.done;
  }

  /** Removes the burst at once (also used by the e2e freeze hook). */
  stop() {
    if (this.done) return;
    this.done = true;
    this.emitter.destroy();
  }
}
