import type Phaser from 'phaser';
import { renderScale } from '../../hidpi';

// Canvas renderer on purpose (AGENTS.md): what repeats is drawn once into a canvas texture and shown as an Image, with
// plain 2D canvas calls (no WebGL-only feature). Baked at `renderScale()` times 2: the player can pinch to 3x, and a
// texture at 1x would go soft there. Every key carries the factor, so a moved window (other density) bakes anew.
const OVERSAMPLE = 2;

/** Texture pixels per world unit of what `bake*` makes. An Image made from it is shown at `1 / bakeFactor()`. */
export function bakeFactor(): number {
  return renderScale() * OVERSAMPLE;
}

function css(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function bake(
  scene: Phaser.Scene,
  key: string,
  w: number,
  h: number,
  draw: (ctx: CanvasRenderingContext2D, k: number) => void
): string {
  const k = bakeFactor();
  const full = `${key}@${k}`;
  if (scene.textures.exists(full)) return full;
  const texture = scene.textures.createCanvas(full, Math.ceil(w * k), Math.ceil(h * k))!;
  const ctx = texture.getContext();
  ctx.scale(k, k);
  draw(ctx, k);
  texture.refresh();
  return full;
}

/** One circle of a target marker, in world units around the cell centre. */
export interface RingLayer {
  radius: number;
  width: number;
  color: number;
  alpha: number;
  /** a filled disc under the stroke */
  fillAlpha?: number;
  /** a dashed ring (Phaser graphics has no dash style): this many dashes, each half of its slot */
  dashes?: number;
}

export interface TargetRing {
  color: number;
  /** squeeze: a dashed amber ring */
  squeeze: boolean;
  /** slingshot: a gold ring, doubled when only the slingshot puts the target in reach */
  slingshot: boolean;
  slingshotOnly: boolean;
  /** tuck: the move ends 1-2 cells behind a car in its lane, so the car is in the tow for its next move: a blue dashed ring */
  tuck: boolean;
  /** risk: the move leaves a resource under 20% (thin ring) or empty (thick ring) */
  risk: 'none' | 'low' | 'empty';
}

/** The circles of a target marker, bottom to top. */
export function targetLayers(t: TargetRing): RingLayer[] {
  const layers: RingLayer[] = [
    { radius: 10, width: 2, color: t.color, alpha: 0.95, fillAlpha: 0.4 }
  ];
  if (t.squeeze) layers.push({ radius: 13, width: 3, color: 0xffb020, alpha: 1, dashes: 10 });
  // (dashed like the squeeze ring but blue and thinner: a squeeze target never ends tucked in, it has no free lane)
  if (t.tuck) layers.push({ radius: 13, width: 2, color: 0x7fb4ff, alpha: 1, dashes: 8 });
  if (t.slingshot) {
    layers.push({ radius: 13, width: 2, color: 0xffd166, alpha: 1 });
    if (t.slingshotOnly) layers.push({ radius: 16, width: 2, color: 0xffd166, alpha: 1 });
  }
  if (t.risk !== 'none') {
    layers.push({ radius: 14, width: t.risk === 'empty' ? 4 : 2, color: 0xff4d4d, alpha: 1 });
  }
  return layers;
}

/** The ring of the target picked with a tap (Move here is next). */
export const SELECTED_RING: RingLayer[] = [{ radius: 16, width: 3, color: 0xffffff, alpha: 1 }];

// All layers fit in a box this wide (the biggest ring, 16, plus its stroke), centred on the cell.
const RING_BOX = 40;

/** Texture key of a marker, baked on first use. The image is centred: its origin is the cell. */
export function ringTexture(scene: Phaser.Scene, layers: RingLayer[]): string {
  const key = `ring:${layers.map((l) => [l.radius, l.width, l.color, l.alpha, l.fillAlpha ?? 0, l.dashes ?? 0].join('/')).join(',')}`;
  return bake(scene, key, RING_BOX, RING_BOX, (ctx) => {
    const c = RING_BOX / 2;
    for (const l of layers) {
      if (l.fillAlpha !== undefined) {
        ctx.globalAlpha = l.fillAlpha;
        ctx.fillStyle = css(l.color);
        ctx.beginPath();
        ctx.arc(c, c, l.radius, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = l.alpha;
      ctx.strokeStyle = css(l.color);
      ctx.lineWidth = l.width;
      const slots = l.dashes ?? 1;
      for (let i = 0; i < slots; i += 1) {
        const a0 = (i / slots) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(c, c, l.radius, a0, a0 + (l.dashes ? Math.PI / slots : Math.PI * 2));
        ctx.stroke();
      }
    }
  });
}

/** A car picture at its display size (w x h world units), downscaled once instead of on every frame. */
export function carBodyTexture(
  scene: Phaser.Scene,
  spriteKey: string,
  w: number,
  h: number
): string {
  return bake(scene, `body:${spriteKey}`, w, h, (ctx) => {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scene.textures.get(spriteKey).getSourceImage() as HTMLImageElement, 0, 0, w, h);
  });
}

const BADGE = 12;

/** The dark disc with the car number, which stays upright while the body turns. Centred on the car. */
export function badgeTexture(scene: Phaser.Scene, carId: number): string {
  return bake(scene, `badge:${carId}`, BADGE, BADGE, (ctx) => {
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = css(0x0b0f14);
    ctx.beginPath();
    ctx.arc(BADGE / 2, BADGE / 2, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#ffffff';
    const text = String(carId);
    // Two digits (cars 10 and 11) are wider than the disc at 9px: a smaller font, and a width cap so the digits stay
    // inside whatever monospace font the device has (fillText squeezes the text to fit).
    ctx.font = text.length > 1 ? '8px monospace' : '9px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, BADGE / 2, BADGE / 2, text.length > 1 ? 8.2 : undefined);
  });
}

/** A solid square of one colour, 8 world units: a confetti piece is it, stretched with `setDisplaySize`. */
export function swatchTexture(scene: Phaser.Scene, color: number): string {
  return bake(scene, `swatch:${color}`, 8, 8, (ctx) => {
    ctx.fillStyle = css(color);
    ctx.fillRect(0, 0, 8, 8);
  });
}
