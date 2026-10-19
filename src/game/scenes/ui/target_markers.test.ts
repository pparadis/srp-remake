import type Phaser from 'phaser';
import { describe, expect, it } from 'vitest';
import { targetLayers, type TargetRing } from '../rendering/baked_textures';
import { TargetMarkers, type TargetMarker } from './target_markers';

const plain: TargetRing = {
  color: 0x3aa0ff,
  squeeze: false,
  slingshot: false,
  slingshotOnly: false,
  tuck: false,
  risk: 'none'
};

// Just enough of a scene: counts what is made, records what is changed.
function fakeScene() {
  const made = { images: 0, texts: 0, canvases: [] as string[], setText: 0 };
  const textures = new Map<string, true>();
  const ctx = new Proxy({}, { get: () => () => undefined, set: () => true });
  const gameObject = () => {
    const o: Record<string, unknown> = { visible: true, texture: { key: '' }, text: '' };
    const chain =
      (f: (...a: unknown[]) => void) =>
      (...a: unknown[]) => (f(...a), o);
    o.setScale = chain(() => undefined);
    o.setDepth = chain(() => undefined);
    o.setOrigin = chain(() => undefined);
    o.setPosition = chain((x, y) => Object.assign(o, { x, y }));
    o.setVisible = chain((v) => (o.visible = v));
    o.setTexture = chain((key) => ((o.texture as { key: string }).key = key as string));
    o.setText = chain((t) => {
      made.setText += 1;
      o.text = t;
    });
    return o;
  };
  const scene = {
    add: {
      image: (_x: number, _y: number, key: string) => {
        made.images += 1;
        const o = gameObject();
        (o.texture as { key: string }).key = key;
        return o;
      },
      text: () => {
        made.texts += 1;
        return gameObject();
      }
    },
    textures: {
      exists: (key: string) => textures.has(key),
      createCanvas: (key: string) => {
        textures.set(key, true);
        made.canvases.push(key);
        return { getContext: () => ctx, refresh: () => undefined };
      }
    }
  };
  return { scene: scene as unknown as Phaser.Scene, made };
}

const marker = (x: number, cost: string, ring = plain): TargetMarker => ({ x, y: 5, cost, ring });

describe('targetLayers', () => {
  it('is the lane disc alone for a plain target', () => {
    expect(targetLayers(plain)).toEqual([
      { radius: 10, width: 2, color: 0x3aa0ff, alpha: 0.95, fillAlpha: 0.4 }
    ]);
  });

  it('stacks squeeze, slingshot (doubled when only the slingshot reaches) and risk, bottom to top', () => {
    const layers = targetLayers({
      ...plain,
      squeeze: true,
      slingshot: true,
      slingshotOnly: true,
      risk: 'empty'
    });
    expect(layers.map((l) => [l.radius, l.width, l.color])).toEqual([
      [10, 2, 0x3aa0ff],
      [13, 3, 0xffb020],
      [13, 2, 0xffd166],
      [16, 2, 0xffd166],
      [14, 4, 0xff4d4d]
    ]);
    expect(layers[1]!.dashes).toBe(10);
  });

  it("a move that ends tucked in behind a car gets a thin dashed blue ring under the slingshot's gold one", () => {
    const layers = targetLayers({ ...plain, tuck: true, slingshot: true });
    expect(layers.map((l) => [l.radius, l.color, l.dashes ?? 0])).toEqual([
      [10, 0x3aa0ff, 0],
      [13, 0x7fb4ff, 8],
      [13, 0xffd166, 0]
    ]);
  });

  it('a low resource gives the thin risk ring', () => {
    expect(targetLayers({ ...plain, risk: 'low' }).at(-1)).toMatchObject({
      radius: 14,
      width: 2,
      color: 0xff4d4d
    });
  });
});

describe('TargetMarkers', () => {
  it('reuses its images and texts: a redraw makes nothing and rasterises only a changed cost', () => {
    const { scene, made } = fakeScene();
    const markers = new TargetMarkers(scene);
    markers.show([marker(0, '1'), marker(10, '2')], null);
    const first = { images: made.images, texts: made.texts, setText: made.setText };
    expect(first).toEqual({ images: 2, texts: 2, setText: 2 });

    markers.show([marker(1, '1'), marker(11, '3')], null);
    expect(made.images).toBe(2);
    expect(made.texts).toBe(2);
    expect(made.setText).toBe(3); // only "2" became "3"
  });

  it('hides what a shorter redraw no longer shows, and everything on clear', () => {
    const { scene } = fakeScene();
    const shown: boolean[] = [];
    const markers = new TargetMarkers(scene);
    markers.show([marker(0, '1'), marker(10, '2'), marker(20, '3')], null);
    markers.show([marker(0, '1')], null);
    const pool = (markers as unknown as { rings: Array<{ visible: boolean }> }).rings;
    shown.push(...pool.map((r) => r.visible));
    expect(shown).toEqual([true, false, false]);
    markers.clear();
    expect(pool.every((r) => !r.visible)).toBe(true);
  });

  it('bakes one texture per distinct marker, not per target', () => {
    const { scene, made } = fakeScene();
    const markers = new TargetMarkers(scene);
    markers.show(
      [marker(0, '1'), marker(10, '1'), marker(20, '1', { ...plain, risk: 'low' })],
      null
    );
    markers.show([marker(0, '1')], { x: 3, y: 4 });
    expect(made.canvases).toHaveLength(3); // plain, risk, selected
  });
});
