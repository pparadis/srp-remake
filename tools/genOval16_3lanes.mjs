import fs from "node:fs";
import path from "node:path";
import { buildLanePoints } from "./track/geometry.mjs";
import { findBestStartIndex } from "./track/sequence.mjs";

const CONFIG = {
  lanes: 4,
  mainLanes: [1, 2, 3],
  pitLane: 0,
  pitZones: [28, 1, 2, 3, 4, 5, 6],
  straightCount: 8,
  cornerCounts: { 1: 6, 2: 7, 3: 8 },
  geometry: {
    cx: 560,
    cy: 350,
    laneSpacing: 24,
    pitInsetFromInnerLane: 44,
    baseRadius: 120,
    straightHalf: 260,
    startZoneOffset: 12
  }
};

const outDir = path.join(process.cwd(), "public", "tracks");
fs.mkdirSync(outDir, { recursive: true });

function id(z, l) {
  return `Z${String(z).padStart(2, "0")}_L${l}_00`;
}

const {
  lanes,
  mainLanes,
  pitLane,
  pitZones,
  straightCount,
  cornerCounts,
  geometry: {
    cx,
    cy,
    laneSpacing,
    pitInsetFromInnerLane,
    baseRadius,
    straightHalf,
    startZoneOffset
  }
} = CONFIG;

const sortedMainLanes = [...mainLanes].sort((a, b) => a - b);
const innerMainLane = sortedMainLanes[0];
const middleMainLane = sortedMainLanes[1];
const outerMainLane = sortedMainLanes[2];

const cells = [];
const laneSequences = new Map();
const laneAngleByZone = new Map();
const laneLengths = new Map();
let startLineRef = null;

for (const lane of mainLanes) {
  const seq = [];
  const angleByZone = new Map();
  const points = buildLanePoints({
    cx,
    cy,
    lane,
    laneSpacing,
    baseRadius,
    straightHalf,
    straightCount,
    cornerCounts
  });

  const len = points.length;
  const startIndex0 = lane === innerMainLane ? (len - startZoneOffset) % len : null;
  if (lane === innerMainLane) {
    const p = points[startIndex0];
    startLineRef = { x: p.x, y: p.y };
  }
  let startIndex = startIndex0 ?? 0;
  if (lane !== innerMainLane && startLineRef) {
    startIndex = findBestStartIndex(points, startLineRef);
  }

  for (let k = 0; k < len; k += 1) {
    const p = points[(startIndex + k) % len];
    const zoneIndex = k + 1;
    const cell = {
      id: id(zoneIndex, lane),
      zoneIndex,
      laneIndex: lane,
      forwardIndex: 0,
      pos: { x: Math.round(p.x), y: Math.round(p.y) },
      next: [],
      tags: []
    };
    if (lane !== pitLane && zoneIndex === 1) cell.tags.push("START_FINISH");
    cells.push(cell);
    seq.push({ cell, progress: k / len, nx: p.nx, ny: p.ny });
    angleByZone.set(zoneIndex, { nx: p.nx, ny: p.ny, x: p.x, y: p.y });
  }
  laneSequences.set(lane, seq);
  laneAngleByZone.set(lane, angleByZone);
  laneLengths.set(lane, len);
}

const maxZones = Math.max(...Array.from(laneLengths.values()));

for (const z of pitZones) {
  const refLaneIndex = innerMainLane;
  const refLane = laneAngleByZone.get(innerMainLane);
  const ref = refLane?.get(z);
  if (!ref) continue;
  const baseX = ref.x;
  const baseY = ref.y;
  const toCenterX = cx - baseX;
  const toCenterY = cy - baseY;
  const normalDot = ref.nx * toCenterX + ref.ny * toCenterY;
  const dir = normalDot >= 0 ? 1 : -1;
  const totalInset = (refLaneIndex - innerMainLane) * laneSpacing + pitInsetFromInnerLane;
  const pitX = baseX + ref.nx * totalInset * dir;
  const pitY = baseY + ref.ny * totalInset * dir;
  const pitCell = {
    id: id(z, pitLane),
    zoneIndex: z,
    laneIndex: pitLane,
    forwardIndex: 0,
    pos: { x: Math.round(pitX), y: Math.round(pitY) },
    next: [],
    tags: []
  };

  if (z === 28) pitCell.tags.push("PIT_ENTRY");
  if (z === 2 || z === 3) pitCell.tags.push("PIT_BOX");
  if (z === 6) pitCell.tags.push("PIT_EXIT");

  cells.push(pitCell);
}

const cellById = new Map(cells.map((c) => [c.id, c]));

const spineLane = 1;
const spineSeq = laneSequences.get(spineLane);
if (!spineSeq) {
  throw new Error(`Missing spine lane sequence for lane ${spineLane}`);
}
const spineLen = spineSeq.length;
for (let i = 0; i < spineLen; i += 1) {
  spineSeq[i].cell.forwardIndex = i;
}

function toSpineForwardIndex(zoneIndex) {
  const raw = (zoneIndex - 1) % spineLen;
  return raw < 0 ? raw + spineLen : raw;
}

function inWrapRange(zoneIndex, start, end, laneLen) {
  if (start <= end) return zoneIndex >= start && zoneIndex <= end;
  return zoneIndex >= start && zoneIndex <= laneLen || zoneIndex >= 1 && zoneIndex <= end;
}

function mappedStraightSpineZone(zoneIndex, laneIndex, laneLen) {
  // Straight mapping by lane:
  // L1: Z28..Z06 and Z14..Z20
  // L2: Z30..Z06 and Z15..Z21
  // L3: Z32..Z06 and Z16..Z22
  // All map to spine straight zones:
  //   first straight -> Z28..Z06
  //   second straight -> Z14..Z20
  if (laneIndex === 1) {
    if (inWrapRange(zoneIndex, 28, 6, laneLen)) return zoneIndex === 28 ? 28 : zoneIndex;
    if (zoneIndex >= 14 && zoneIndex <= 20) return zoneIndex;
    return null;
  }
  if (laneIndex === 2) {
    if (inWrapRange(zoneIndex, 30, 6, laneLen)) return zoneIndex === 30 ? 28 : zoneIndex;
    if (zoneIndex >= 15 && zoneIndex <= 21) return zoneIndex - 1;
    return null;
  }
  if (laneIndex === 3) {
    if (inWrapRange(zoneIndex, 32, 6, laneLen)) return zoneIndex === 32 ? 28 : zoneIndex;
    if (zoneIndex >= 16 && zoneIndex <= 22) return zoneIndex - 2;
    return null;
  }
  return null;
}

for (const lane of mainLanes) {
  if (lane === spineLane) continue;
  const seq = laneSequences.get(lane);
  if (!seq) continue;
  const len = seq.length;
  const denom = Math.max(1, len - 1);
  for (let k = 0; k < len; k += 1) {
    const entry = seq[k];
    // Keep banking offsets in corners via per-lane progress mapping.
    const progress = k / denom;
    const spineIndex = Math.round(progress * (spineLen - 1));
    entry.cell.forwardIndex = spineIndex;

    // Normalize forward index across lanes on straights.
    const spineStraightZone = mappedStraightSpineZone(entry.cell.zoneIndex, lane, len);
    if (spineStraightZone != null) {
      entry.cell.forwardIndex = toSpineForwardIndex(spineStraightZone);
    }
  }
}

const pitLen = pitZones.length;
const pitDenom = Math.max(1, pitLen - 1);
for (let i = 0; i < pitLen; i += 1) {
  const pitCell = cellById.get(id(pitZones[i], pitLane));
  if (!pitCell) continue;
  const progress = i / pitDenom;
  pitCell.forwardIndex = Math.round(progress * (spineLen - 1));
}

function forwardLaneTarget(targetLane, progress) {
  const seq = laneSequences.get(targetLane);
  if (!seq) return null;
  let best = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (let i = 0; i < seq.length; i += 1) {
    const candidate = seq[i];
    const candidateProgress = i / seq.length;
    const delta = (candidateProgress - progress + 1) % 1;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = candidate.cell;
    }
  }
  return best;
}

for (const lane of mainLanes) {
  const seq = laneSequences.get(lane);
  if (!seq) continue;
  const len = seq.length;
  for (let i = 0; i < len; i += 1) {
    const { cell } = seq[i];
    const progress = i / len;
    const targets = new Set();

    const nextSame = seq[(i + 1) % len].cell;
    targets.add(nextSame.id);

    if (lane === innerMainLane) {
      const middleLaneTarget = forwardLaneTarget(middleMainLane, progress);
      if (middleLaneTarget) targets.add(middleLaneTarget.id);
    }
    if (lane === middleMainLane) {
      const innerLaneTarget = forwardLaneTarget(innerMainLane, progress);
      const outerLaneTarget = forwardLaneTarget(outerMainLane, progress);
      if (innerLaneTarget) targets.add(innerLaneTarget.id);
      if (outerLaneTarget) targets.add(outerLaneTarget.id);
    }
    if (lane === outerMainLane) {
      const middleLaneTarget = forwardLaneTarget(middleMainLane, progress);
      if (middleLaneTarget) targets.add(middleLaneTarget.id);
    }

    if (cell.zoneIndex === 27 && lane === innerMainLane) {
      const pitEntry = cellById.get(id(28, pitLane));
      if (pitEntry) targets.add(pitEntry.id);
    }

    cell.next = Array.from(targets);
    if (cell.tags.length === 0) delete cell.tags;
  }
}

for (let i = 0; i < pitZones.length; i += 1) {
  const z = pitZones[i];
  const pitCell = cellById.get(id(z, pitLane));
  if (!pitCell) continue;
  const targets = new Set();
  const nextZone = pitZones[(i + 1) % pitZones.length];
  if (z === 6) {
    const exitMain = cellById.get(id(7, innerMainLane));
    if (exitMain) targets.add(exitMain.id);
  } else {
    const nextPit = cellById.get(id(nextZone, pitLane));
    if (nextPit) targets.add(nextPit.id);
  }
  pitCell.next = Array.from(targets);
  if (pitCell.tags.length === 0) delete pitCell.tags;
}

const track = {
  trackId: "oval16_3lanes",
  zones: maxZones,
  lanes,
  cells
};

const outPath = path.join(outDir, "oval16_3lanes.json");
fs.writeFileSync(outPath, JSON.stringify(track, null, 2), "utf-8");

console.log(`Generated: ${outPath}`);
