import Phaser from "phaser";

interface Piece {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  angle: number;
  size: number;
  color: number;
}

const COLORS = [0xffe066, 0xff5a5a, 0x4cd964, 0x4da3ff, 0xffffff, 0xff9f43];

/** One burst of confetti in screen space, drawn with a Graphics object and gone after `lifeMs`. */
export class Confetti {
  private pieces: Piece[] = [];
  private g: Phaser.GameObjects.Graphics;
  private age = 0;
  private done = false;
  private readonly onUpdate = (_time: number, delta: number) => this.step(delta);
  private scene: Phaser.Scene;
  private lifeMs: number;

  constructor(scene: Phaser.Scene, lifeMs = 3500, count = 120) {
    this.scene = scene;
    this.lifeMs = lifeMs;
    const { width, height } = scene.scale;
    const zoom = scene.cameras.main.zoom;
    const k = 1 / zoom;
    // Fixed objects are zoomed with the camera; undo that so the burst covers the screen.
    this.g = scene.add.graphics().setScrollFactor(0).setDepth(90).setScale(k).setPosition((width / 2) * (1 - k), (height / 2) * (1 - k));
    for (let i = 0; i < count; i += 1) {
      this.pieces.push({
        x: Math.random() * width,
        y: -20 - Math.random() * height * 0.4,
        vx: (Math.random() - 0.5) * 120,
        vy: 120 + Math.random() * 220,
        spin: (Math.random() - 0.5) * 8,
        angle: Math.random() * Math.PI,
        size: 5 + Math.random() * 5,
        color: COLORS[i % COLORS.length]!
      });
    }
    scene.events.on(Phaser.Scenes.Events.UPDATE, this.onUpdate);
    scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.stop());
  }

  private step(delta: number) {
    if (this.done) return;
    const dt = Math.min(delta, 50) / 1000;
    this.age += delta;
    if (this.age >= this.lifeMs) return this.stop();
    this.g.clear();
    this.g.setAlpha(Math.min(1, (this.lifeMs - this.age) / 600));
    for (const p of this.pieces) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.angle += p.spin * dt;
      this.g.fillStyle(p.color, 1);
      const w = p.size * (0.4 + Math.abs(Math.cos(p.angle)));
      this.g.fillRect(p.x - w / 2, p.y - p.size / 2, w, p.size);
    }
  }

  /** Removes the burst at once (also used by the e2e freeze hook). */
  stop() {
    if (this.done) return;
    this.done = true;
    this.scene.events.off(Phaser.Scenes.Events.UPDATE, this.onUpdate);
    this.g.destroy();
  }
}
