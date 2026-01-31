import fs from "node:fs";
import path from "node:path";

const zones = 32;
const lanes = 4;
const mainLanes = [0, 1, 2];
const pitLane = 3;
const pitZones = [4, 5, 6, 7, 8, 9, 10];

const outDir = path.join(process.cwd(), "public", "tracks");
fs.mkdirSync(outDir, { recursive: true });

function id(z, l) {
  return `Z${String(z).padStart(2, "0")}_L${l}_00`;
}

const cx = 560;
const cy = 350;
const rx = 360;
const ry = 210;

function posFor(z, lane) {
  const t = ((z - 1) / zones) * Math.PI * 2;
  const baseX = cx + Math.cos(t) * rx;
  const baseY = cy + Math.sin(t) * ry;

  const nx = Math.cos(t);
  const ny = Math.sin(t);
  const laneOffset = lane === pitLane ? -36 : (lane - 1) * 18;

  return {
    x: Math.round(baseX + nx * laneOffset),
    y: Math.round(baseY + ny * laneOffset)
  };
}

const cells = [];

for (let z = 1; z <= zones; z++) {
  for (const lane of mainLanes) {
    const cell = {
      id: id(z, lane),
      zoneIndex: z,
      laneIndex: lane,
      pos: posFor(z, lane),
      next: [],
      tags: []
    };

    if (z === 1 && lane === 1) cell.tags.push("START_FINISH");
    cells.push(cell);
  }

  if (pitZones.includes(z)) {
    const pitCell = {
      id: id(z, pitLane),
      zoneIndex: z,
      laneIndex: pitLane,
      pos: posFor(z, pitLane),
      next: [],
      tags: []
    };

    if (z === 4) pitCell.tags.push("PIT_ENTRY");
    if (z === 6 || z === 7 || z === 8) pitCell.tags.push("PIT_BOX");
    if (z === 10) pitCell.tags.push("PIT_EXIT");

    cells.push(pitCell);
  }
}

for (const c of cells) {
  const z = c.zoneIndex;
  const lane = c.laneIndex;
  const nextZone = z === zones ? 1 : z + 1;

  const targets = new Set();

  if (mainLanes.includes(lane)) {
    targets.add(id(nextZone, lane));

    if (lane === 0) targets.add(id(nextZone, 1));
    if (lane === 1) {
      targets.add(id(nextZone, 0));
      targets.add(id(nextZone, 2));
    }
    if (lane === 2) targets.add(id(nextZone, 1));

    if (z === 4 && lane === 0) {
      targets.add(id(z, pitLane));
    }
  } else if (lane === pitLane) {
    if (z < 10) {
      targets.add(id(nextZone, pitLane));
    } else {
      targets.add(id(nextZone, 0));
    }
  }

  c.next = Array.from(targets);
  if (c.tags.length === 0) delete c.tags;
}

const track = {
  trackId: "oval16_3lanes",
  zones,
  lanes,
  cells
};

const outPath = path.join(outDir, "oval16_3lanes.json");
fs.writeFileSync(outPath, JSON.stringify(track, null, 2), "utf-8");

console.log(`Generated: ${outPath}`);
