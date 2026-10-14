import type Phaser from "phaser";

/** A press that travels less than this (screen pixels) is a tap, not a pan; the same slop the tap-to-move uses. */
const PAN_SLOP_PX = 10;
const DOUBLE_TAP_MS = 320;
const DOUBLE_TAP_PX = 30;

interface CameraGestureParams {
  scene: Phaser.Scene;
  /** The player's finger(s) moved the board by this much (screen pixels): one finger, content follows it. */
  onPan: (dx: number, dy: number) => void;
  /** Two fingers: where they are and how far apart now, and where they were. */
  onPinch: (last: { x: number; y: number; dist: number }, now: { x: number; y: number; dist: number }) => void;
  /** The wheel (desktop): zoom about the pointer. */
  onWheel: (x: number, y: number, deltaY: number) => void;
  /** Two quick taps on the empty board: back to the fit. */
  onDoubleTap: () => void;
  /** False while a modal is open or cars are being edited: no gestures then. */
  enabled: () => boolean;
}

/**
 * Pinch-zoom, pan and double-tap on the empty board, and the wheel. A press that starts on a game object (a car, a
 * button) belongs to that object and never pans; a press that moves less than the tap slop stays a tap, so tap-to-move
 * keeps working at any zoom. Two fingers cancel a pan and pinch instead.
 */
export function registerCameraGestures(params: CameraGestureParams): void {
  const { scene, onPan, onPinch, onWheel, onDoubleTap, enabled } = params;
  scene.input.addPointer(1); // a second finger: the default is one touch pointer plus the mouse

  let panId: number | null = null;
  let last = { x: 0, y: 0 };
  let panning = false;
  let pinch: { x: number; y: number; dist: number } | null = null;
  let lastTap: { t: number; x: number; y: number } | null = null;

  const touches = () => [scene.input.pointer1, scene.input.pointer2].filter((p) => p?.isDown);
  const pinchNow = () => {
    const [a, b] = touches();
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, dist: Math.hypot(a.x - b.x, a.y - b.y) };
  };

  scene.input.on("pointerdown", (pointer: Phaser.Input.Pointer, over: Phaser.GameObjects.GameObject[]) => {
    if (!enabled()) return;
    if (pinchNow()) {
      // a second finger: whatever the first was doing, this is a pinch now
      panId = null;
      panning = false;
      pinch = pinchNow();
      lastTap = null;
      return;
    }
    if (over.length > 0) return; // a car or a button
    panId = pointer.id;
    last = { x: pointer.x, y: pointer.y };
    panning = false;
  });

  scene.input.on("pointermove", (pointer: Phaser.Input.Pointer) => {
    if (!enabled()) return;
    if (pinch) {
      const now = pinchNow();
      if (!now) return;
      onPinch(pinch, now);
      pinch = now;
      return;
    }
    if (panId !== pointer.id || !pointer.isDown) return;
    if (!panning) {
      if (pointer.getDistance() <= PAN_SLOP_PX) return;
      panning = true; // the slop is spent: from here the board follows the finger
      last = { x: pointer.x, y: pointer.y };
      return;
    }
    onPan(pointer.x - last.x, pointer.y - last.y);
    last = { x: pointer.x, y: pointer.y };
  });

  scene.input.on("pointerup", (pointer: Phaser.Input.Pointer) => {
    if (pinch) {
      if (!pinchNow()) pinch = null; // fewer than two fingers down: the pinch is over (a lifted finger does not pan)
      panId = null;
      panning = false;
      return;
    }
    if (panId !== pointer.id) return;
    const wasPan = panning;
    panId = null;
    panning = false;
    if (wasPan || !enabled() || pointer.getDistance() > PAN_SLOP_PX) return;
    const now = performance.now();
    if (lastTap && now - lastTap.t <= DOUBLE_TAP_MS && Math.hypot(pointer.x - lastTap.x, pointer.y - lastTap.y) <= DOUBLE_TAP_PX) {
      lastTap = null;
      onDoubleTap();
    } else {
      lastTap = { t: now, x: pointer.x, y: pointer.y };
    }
  });

  scene.input.on("wheel", (pointer: Phaser.Input.Pointer, _over: unknown, _dx: number, dy: number) => {
    if (enabled()) onWheel(pointer.x, pointer.y, dy);
  });
}
