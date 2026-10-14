import { describe, expect, it } from "vitest";
import { centerOn, FITTED, MAX_USER_ZOOM, panBy, pinchTo, screenToWorld, viewOf, wheelTo, type Fit } from "./cameraView";

// A 1000 x 600 canvas, the HUD taking 180 px left and 190 px right, 60 px at the top, 50 below; a 900 x 360 track, so
// the fit zoom is the free width over the box width: 630 / 900.
const fit: Fit = { zoom: 0.7, bx: 500, by: 300, bw: 900, bh: 360, w: 1000, h: 600, gl: 180, gr: 190, top: 60, bottom: 50, scale: 1 };
const freeCentre = { x: fit.gl + (fit.w - fit.gl - fit.gr) / 2, y: fit.top + (fit.h - fit.top - fit.bottom) / 2 };

describe("viewOf", () => {
  it("is the fit when the player has not touched it: the box is centred in the free area", () => {
    const v = viewOf(fit, FITTED);
    expect(v.zoom).toBeCloseTo(0.7);
    const centred = screenToWorld(fit, v, freeCentre.x, freeCentre.y);
    expect(centred.x).toBeCloseTo(500);
    expect(centred.y).toBeCloseTo(300);
  });

  it("keeps the zoom between the fit and 3x it, and under the absolute cap on a dense screen", () => {
    expect(viewOf(fit, { zoom: 0.2, px: 0, py: 0 }).user.zoom).toBe(1);
    expect(viewOf(fit, { zoom: 9, px: 0, py: 0 }).user.zoom).toBe(MAX_USER_ZOOM);
    const dense: Fit = { ...fit, zoom: 1.6, scale: 2 };
    expect(viewOf(dense, { zoom: 9, px: 0, py: 0 }).zoom).toBeLessThanOrEqual(MAX_USER_ZOOM * 2);
  });

  it("cannot pan the fitted track, and pans the zoomed one only as far as the track's box", () => {
    expect(viewOf(fit, { zoom: 1, px: 300, py: 200 }).user).toMatchObject({ px: 0, py: 0 });
    const zoomed = viewOf(fit, { zoom: 3, px: 5000, py: -5000 });
    expect(zoomed.user.px).toBeGreaterThan(0);
    expect(zoomed.user.px).toBeLessThan(900 / 2 + 41);
    expect(zoomed.user.py).toBeLessThan(0);
  });
});

describe("pinchTo and wheelTo", () => {
  it("zooms by the ratio of the fingers and keeps the world point under them", () => {
    const mid = { x: 600, y: 250 };
    const before = viewOf(fit, FITTED);
    const held = screenToWorld(fit, before, mid.x, mid.y);
    const user = pinchTo(fit, FITTED, { ...mid, dist: 100 }, { ...mid, dist: 200 });
    expect(user.zoom).toBeCloseTo(2);
    const after = viewOf(fit, user);
    const under = screenToWorld(fit, after, mid.x, mid.y);
    expect(under.x).toBeCloseTo(held.x, 3);
    expect(under.y).toBeCloseTo(held.y, 3);
  });

  it("drags the content with the fingers while they move", () => {
    const start = pinchTo(fit, FITTED, { x: 500, y: 300, dist: 100 }, { x: 500, y: 300, dist: 200 });
    const held = screenToWorld(fit, viewOf(fit, start), 500, 300);
    const moved = pinchTo(fit, start, { x: 500, y: 300, dist: 100 }, { x: 540, y: 320, dist: 100 });
    const under = screenToWorld(fit, viewOf(fit, moved), 540, 320);
    expect(under.x).toBeCloseTo(held.x, 3);
    expect(under.y).toBeCloseTo(held.y, 3);
  });

  it("ignores a degenerate pinch, and the wheel zooms about the pointer", () => {
    expect(pinchTo(fit, FITTED, { x: 0, y: 0, dist: 0 }, { x: 0, y: 0, dist: 50 })).toEqual(FITTED);
    const zoomedIn = wheelTo(fit, FITTED, 620, 260, -300);
    expect(zoomedIn.zoom).toBeGreaterThan(1);
    const held = screenToWorld(fit, viewOf(fit, FITTED), 620, 260);
    const under = screenToWorld(fit, viewOf(fit, zoomedIn), 620, 260);
    expect(under.x).toBeCloseTo(held.x, 3);
    expect(wheelTo(fit, zoomedIn, 620, 260, 5000).zoom).toBe(1); // zooming out stops at the fit
  });
});

describe("panBy and centerOn", () => {
  it("moves the content with the finger", () => {
    const zoomed = pinchTo(fit, FITTED, { x: 500, y: 300, dist: 100 }, { x: 500, y: 300, dist: 250 });
    const point = screenToWorld(fit, viewOf(fit, zoomed), 400, 300);
    const panned = panBy(fit, zoomed, 60, -30);
    const moved = screenToWorld(fit, viewOf(fit, panned), 460, 270);
    expect(moved.x).toBeCloseTo(point.x, 3);
    expect(moved.y).toBeCloseTo(point.y, 3);
  });

  it("puts a world point at the centre of the free area", () => {
    const zoomed: typeof FITTED = { zoom: 2.5, px: 0, py: 0 };
    const user = centerOn(fit, zoomed, 700, 240);
    const at = screenToWorld(fit, viewOf(fit, user), freeCentre.x, freeCentre.y);
    expect(at.x).toBeCloseTo(700, 3);
    expect(at.y).toBeCloseTo(240, 3);
  });
});
