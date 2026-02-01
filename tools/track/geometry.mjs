function addStraight(points, count, x0, y0, x1, y1) {
  const steps = Math.max(2, count);
  for (let i = 0; i < steps; i += 1) {
    const t = i / steps;
    const x = x0 + (x1 - x0) * t;
    const y = y0 + (y1 - y0) * t;
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    points.push({ x, y, nx, ny });
  }
}

function addArc(points, count, cxArc, cyArc, radius, startAngle, endAngle) {
  const steps = Math.max(2, count);
  for (let i = 0; i < steps; i += 1) {
    const t = i / steps;
    const ang = startAngle + (endAngle - startAngle) * t;
    const x = cxArc + Math.cos(ang) * radius;
    const y = cyArc + Math.sin(ang) * radius;
    const nx = Math.cos(ang);
    const ny = Math.sin(ang);
    points.push({ x, y, nx, ny });
  }
}

export function buildLanePoints({
  cx,
  cy,
  lane,
  laneSpacing,
  baseRadius,
  straightHalf,
  straightCount,
  cornerCounts
}) {
  const radius = baseRadius + (lane - 1) * laneSpacing;
  const points = [];
  const yTop = cy - radius;
  const yBottom = cy + radius;
  const leftCx = cx - straightHalf;
  const rightCx = cx + straightHalf;

  addStraight(points, straightCount, leftCx, yTop, rightCx, yTop);
  addArc(points, cornerCounts[lane], rightCx, cy, radius, -Math.PI / 2, Math.PI / 2);
  addStraight(points, straightCount, rightCx, yBottom, leftCx, yBottom);
  addArc(points, cornerCounts[lane], leftCx, cy, radius, Math.PI / 2, (Math.PI * 3) / 2);

  return points;
}
