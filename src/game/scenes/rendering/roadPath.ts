import Phaser from "phaser";

/**
 * A smooth curve through points (cell positions in order): a straight line for two, a Catmull-Rom spline through
 * the rest. The glide of a car and the preview and trail of a move all follow the same line.
 */
export function roadPath(points: ReadonlyArray<{ x: number; y: number }>): Phaser.Curves.Path {
  const first = points[0] ?? { x: 0, y: 0 };
  const path = new Phaser.Curves.Path(first.x, first.y);
  if (points.length === 2) path.lineTo(points[1]!.x, points[1]!.y);
  else if (points.length > 2) path.splineTo(points.slice(1).map((p) => new Phaser.Math.Vector2(p.x, p.y)));
  return path;
}
