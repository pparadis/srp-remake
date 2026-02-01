import fs from "node:fs";
import path from "node:path";
import { buildLanePoints } from "./track/geometry.mjs";
import { findBestStartIndex } from "./track/sequence.mjs";

const lanes = 4;
const mainLanes = [0, 1, 2];
const pitLane = 3;
const pitZones = [28, 1, 2, 3, 4, 5, 6];
const straightCount = 8;
const cornerCounts = { 0: 6, 1: 7, 2: 8 };

const outDir = path.join(process.cwd(), "public", "tracks");
fs.mkdirSync(outDir, { recursive: true });

function id(z, l) {
  return `Z${String(z).padStart(2, "0")}_L${l}_00`;
}

const cx = 560;
const cy = 350;
const laneSpacing = 18;
const pitInsetFromLane0 = 36;
const baseRadius = 120;
const straightHalf = 260;
const startZoneOffset = 12;

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
  const startIndex0 = lane === 0 ? (len - startZoneOffset) % len : null;
  if (lane === 0) {
    const p = points[startIndex0];
    startLineRef = { x: p.x, y: p.y };
  }
  let startIndex = startIndex0 ?? 0;
  if (lane !== 0 && startLineRef) {
    startIndex = findBestStartIndex(points, startLineRef);
  }

  for (let k = 0; k < len; k += 1) {
    const p = points[(startIndex + k) % len];
    const zoneIndex = k + 1;
    const cell = {
      id: id(zoneIndex, lane),
      zoneIndex,
      laneIndex: lane,
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
  const refLaneIndex = 0;
  const refLane = laneAngleByZone.get(0);
  const ref = refLane?.get(z);
  if (!ref) continue;
  const baseX = ref.x;
  const baseY = ref.y;
  const toCenterX = cx - baseX;
  const toCenterY = cy - baseY;
  const normalDot = ref.nx * toCenterX + ref.ny * toCenterY;
  const dir = normalDot >= 0 ? 1 : -1;
  const totalInset = refLaneIndex * laneSpacing + pitInsetFromLane0;
  const pitX = baseX + ref.nx * totalInset * dir;
  const pitY = baseY + ref.ny * totalInset * dir;
  const pitCell = {
    id: id(z, pitLane),
    zoneIndex: z,
    laneIndex: pitLane,
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

    if (lane === 0) {
      const lane1Target = forwardLaneTarget(1, progress);
      if (lane1Target) targets.add(lane1Target.id);
    }
    if (lane === 1) {
      const lane0Target = forwardLaneTarget(0, progress);
      const lane2Target = forwardLaneTarget(2, progress);
      if (lane0Target) targets.add(lane0Target.id);
      if (lane2Target) targets.add(lane2Target.id);
    }
    if (lane === 2) {
      const lane1Target = forwardLaneTarget(1, progress);
      if (lane1Target) targets.add(lane1Target.id);
    }

    if (cell.zoneIndex === 27 && lane === 0) {
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
    const exitMain = cellById.get(id(7, 0));
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
