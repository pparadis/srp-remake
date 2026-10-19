// The board camera as a pure model (no Phaser): the track is fitted between the HUD panels (`Fit`), and the player may
// zoom in and pan on top of that (`UserView`). `viewOf` turns both into what the camera needs: a zoom and the world point
// at its centre. Screen coordinates are canvas pixels with the origin at the top left.

/** What the fit leaves: the track's bounding box, the canvas, the room the HUD takes, and the zoom that fits. */
export interface Fit {
  zoom: number;
  /** Centre and size of the track's bounding box, world units (curbs included). */
  bx: number;
  by: number;
  bw: number;
  bh: number;
  /** Canvas size, and the free area between the panels: its centre is where the fitted track is centred. */
  w: number;
  h: number;
  /** Pixels the HUD takes at the left, right and top, and the room kept at the bottom for the buttons. */
  gl: number;
  gr: number;
  top: number;
  bottom: number;
  /** Canvas pixels per CSS pixel (hidpi): the absolute zoom cap scales with it. */
  scale: number;
}

/** The player's view on top of the fit: a zoom factor (1 = fitted) and the pan, in world units from the fitted centre. */
export interface UserView {
  zoom: number;
  px: number;
  py: number;
}

export const FITTED: UserView = { zoom: 1, px: 0, py: 0 };
export const MAX_USER_ZOOM = 3;
/** World units of margin the view may go past the track's box. */
const PAN_MARGIN = 40;

export interface CameraView {
  zoom: number;
  /** The world point at the camera's centre (what `centerOn` takes). */
  cx: number;
  cy: number;
  /** The user view, clamped. */
  user: UserView;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** The camera for a fit and a user view; the user view is clamped (zoom range, and pan so the track stays in sight). */
export function viewOf(fit: Fit, wanted: UserView): CameraView {
  const userZoom = clamp(
    wanted.zoom,
    1,
    Math.max(1, Math.min(MAX_USER_ZOOM, (MAX_USER_ZOOM * fit.scale) / fit.zoom))
  );
  const zoom = fit.zoom * userZoom;
  const freeW = fit.w - fit.gl - fit.gr;
  const freeH = fit.h - fit.top - fit.bottom;
  // the centre of the free area may go as far as keeps its edges inside the track's box plus a margin
  // (no margin at the fit: the fitted track does not move)
  const margin = userZoom > 1 ? PAN_MARGIN : 0;
  const limitX = Math.max(0, fit.bw / 2 + margin - freeW / zoom / 2);
  const limitY = Math.max(0, fit.bh / 2 + margin - freeH / zoom / 2);
  const px = clamp(wanted.px, -limitX, limitX);
  const py = clamp(wanted.py, -limitY, limitY);
  // at the fit the bounding box is centred in the free area: shift the camera by half of what the HUD takes
  const cx = fit.bx + px - (fit.gl - fit.gr) / 2 / zoom;
  const cy = fit.by + py + (fit.bottom - fit.top) / 2 / zoom;
  return { zoom, cx, cy, user: { zoom: userZoom, px, py } };
}

/** The world point under a screen point. */
export function screenToWorld(
  fit: Fit,
  view: CameraView,
  sx: number,
  sy: number
): { x: number; y: number } {
  return { x: view.cx + (sx - fit.w / 2) / view.zoom, y: view.cy + (sy - fit.h / 2) / view.zoom };
}

/** A pinch: the fingers went from (`lastMid`, `lastDist` apart) to (`mid`, `dist`): zoom by the ratio and keep the
 * world point that was under the fingers under them. */
export function pinchTo(
  fit: Fit,
  user: UserView,
  last: { x: number; y: number; dist: number },
  now: { x: number; y: number; dist: number }
): UserView {
  if (last.dist <= 0 || now.dist <= 0) return user;
  const before = viewOf(fit, user);
  const held = screenToWorld(fit, before, last.x, last.y);
  const zoomed = viewOf(fit, { ...before.user, zoom: before.user.zoom * (now.dist / last.dist) });
  const under = screenToWorld(fit, zoomed, now.x, now.y);
  return viewOf(fit, {
    zoom: zoomed.user.zoom,
    px: zoomed.user.px + (held.x - under.x),
    py: zoomed.user.py + (held.y - under.y)
  }).user;
}

/** A one-finger pan: the content follows the finger by (`dx`, `dy`) screen pixels. */
export function panBy(fit: Fit, user: UserView, dx: number, dy: number): UserView {
  const { zoom, user: clamped } = viewOf(fit, user);
  return viewOf(fit, { zoom: clamped.zoom, px: clamped.px - dx / zoom, py: clamped.py - dy / zoom })
    .user;
}

/** The user view that puts a world point at the centre of the free area (where the fitted track is centred). */
export function centerOn(fit: Fit, user: UserView, wx: number, wy: number): UserView {
  return viewOf(fit, { zoom: user.zoom, px: wx - fit.bx, py: wy - fit.by }).user;
}

/** A wheel notch (desktop): zoom about the pointer. `deltaY` is the wheel's, negative zooms in. */
export function wheelTo(
  fit: Fit,
  user: UserView,
  sx: number,
  sy: number,
  deltaY: number
): UserView {
  const factor = Math.exp(-deltaY * 0.0015);
  return pinchTo(fit, user, { x: sx, y: sy, dist: 100 }, { x: sx, y: sy, dist: 100 * factor });
}
