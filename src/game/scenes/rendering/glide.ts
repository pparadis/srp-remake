// How long a car takes to glide along its path, and how a round of moves is spread out. Phaser-free.

export const GLIDE = {
  baseMs: 140,
  perStepMs: 45,
  minMs: 180,
  maxMs: 520,
  /** A whole round of glides (every car that moved since the player last looked) should not take longer than this. */
  roundMs: 1500,
  /** How long past the end of a round the board waits for its glides before it unsticks itself (see `RaceScene.watchGlides`). */
  stuckGraceMs: 2000
} as const;

/** The longest one glide may take when `moving` cars glide one after another. */
export function glideCap(moving: number): number {
  if (moving <= 1) return GLIDE.maxMs;
  return Math.max(GLIDE.minMs, Math.min(GLIDE.maxMs, Math.floor(GLIDE.roundMs / moving)));
}

/** Time for a glide over `steps` cells: a little more for a longer move, never over `capMs`. */
export function glideDuration(steps: number, capMs: number = GLIDE.maxMs): number {
  const wanted = GLIDE.baseMs + GLIDE.perStepMs * Math.max(0, steps);
  return Math.round(Math.min(Math.max(GLIDE.minMs, wanted), Math.max(GLIDE.minMs, capMs)));
}
