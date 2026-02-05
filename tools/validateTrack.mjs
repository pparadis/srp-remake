import fs from "node:fs";
import path from "node:path";

const trackPath = process.argv[2] ?? path.join(process.cwd(), "public", "tracks", "oval16_3lanes.json");
const PIT_LANE = 3;
const MAIN_LANES = [0, 1, 2];

function loadTrack(p) {
  const raw = fs.readFileSync(p, "utf-8");
  return JSON.parse(raw);
}

function fail(errors) {
  if (errors.length === 0) return;
  for (const err of errors) {
    console.error(`- ${err}`);
  }
  process.exit(1);
}

function validateTrack(track) {
  const errors = [];
  const cells = track.cells ?? [];
  const byId = new Map();
  const byLane = new Map();
  const byZoneLane = new Map();

  for (const cell of cells) {
    if (byId.has(cell.id)) errors.push(`duplicate cell id: ${cell.id}`);
    byId.set(cell.id, cell);
    const laneArr = byLane.get(cell.laneIndex) ?? [];
    laneArr.push(cell);
    byLane.set(cell.laneIndex, laneArr);
    const key = `${cell.zoneIndex}:${cell.laneIndex}`;
    if (byZoneLane.has(key)) errors.push(`duplicate zone/lane pair: ${key}`);
    byZoneLane.set(key, cell);
  }

  if (track.lanes !== 4) errors.push(`track.lanes must be 4, got ${track.lanes}`);

  for (const cell of cells) {
    if (cell.laneIndex < 0 || cell.laneIndex > 3) {
      errors.push(`invalid laneIndex ${cell.laneIndex} on ${cell.id}`);
    }
    if (cell.zoneIndex < 1) errors.push(`invalid zoneIndex ${cell.zoneIndex} on ${cell.id}`);
    if (!Number.isInteger(cell.forwardIndex) || cell.forwardIndex < 0) {
      errors.push(`invalid forwardIndex ${cell.forwardIndex} on ${cell.id}`);
    }
    for (const nextId of cell.next ?? []) {
      if (!byId.has(nextId)) errors.push(`missing next cell ${nextId} referenced by ${cell.id}`);
    }
  }

  // Contiguous zone indices for each main lane.
  for (const lane of MAIN_LANES) {
    const laneCells = byLane.get(lane) ?? [];
    const zones = laneCells.map((c) => c.zoneIndex).sort((a, b) => a - b);
    for (let i = 0; i < zones.length; i += 1) {
      const expected = zones[0] + i;
      if (zones[i] !== expected) {
        errors.push(`lane ${lane} zone indices not contiguous: expected ${expected}, got ${zones[i]}`);
        break;
      }
    }
  }

  // Spine lane checks (lane 1).
  const spineLane = 1;
  const spineCells = byLane.get(spineLane) ?? [];
  if (spineCells.length === 0) {
    errors.push("spine lane 1 has no cells");
  } else {
    const spineStarts = spineCells.filter((c) => (c.tags ?? []).includes("START_FINISH"));
    if (spineStarts.length !== 1) {
      errors.push(`spine lane must have exactly 1 START_FINISH, got ${spineStarts.length}`);
    }
    const spineForward = spineCells.map((c) => c.forwardIndex).sort((a, b) => a - b);
    for (let i = 0; i < spineForward.length; i += 1) {
      if (spineForward[i] !== i) {
        errors.push(`spine lane forwardIndex not contiguous at ${i}: got ${spineForward[i]}`);
        break;
      }
    }
    const spineMax = spineCells.length - 1;
    for (const cell of cells) {
      if (cell.forwardIndex < 0 || cell.forwardIndex > spineMax) {
        errors.push(`forwardIndex ${cell.forwardIndex} out of spine range 0..${spineMax} on ${cell.id}`);
      }
    }
  }

  // Pit invariants.
  const pitEntry = cells.filter((c) => (c.tags ?? []).includes("PIT_ENTRY"));
  const pitExit = cells.filter((c) => (c.tags ?? []).includes("PIT_EXIT"));
  if (pitEntry.length !== 1) errors.push(`expected 1 PIT_ENTRY, got ${pitEntry.length}`);
  if (pitExit.length !== 1) errors.push(`expected 1 PIT_EXIT, got ${pitExit.length}`);
  for (const c of pitEntry) {
    if (c.laneIndex !== PIT_LANE) errors.push(`PIT_ENTRY must be in lane 3: ${c.id}`);
  }
  for (const c of pitExit) {
    if (c.laneIndex !== PIT_LANE) errors.push(`PIT_EXIT must be in lane 3: ${c.id}`);
  }
  for (const c of cells) {
    if ((c.tags ?? []).includes("PIT_BOX") && c.laneIndex !== PIT_LANE) {
      errors.push(`PIT_BOX must be in lane 3: ${c.id}`);
    }
  }

  // Spine lane forwardIndex monotonicity along next[].
  if (spineCells.length > 0) {
    const start = spineCells.find((c) => (c.tags ?? []).includes("START_FINISH")) ?? spineCells[0];
    const visited = new Set();
    let current = start;
    let steps = 0;
    const expectedNext = (v, max) => (v + 1 > max ? 0 : v + 1);
    const spineMax = spineCells.length - 1;
    while (current && !visited.has(current.id) && steps <= spineCells.length) {
      visited.add(current.id);
      const nextSame = (current.next ?? [])
        .map((id) => byId.get(id))
        .find((c) => c && c.laneIndex === spineLane);
      if (!nextSame) break;
      const expected = expectedNext(current.forwardIndex, spineMax);
      if (nextSame.forwardIndex !== expected) {
        errors.push(`spine forwardIndex jump ${current.id} -> ${nextSame.id} expected ${expected}, got ${nextSame.forwardIndex}`);
        break;
      }
      current = nextSame;
      steps += 1;
    }
  }

  // Pit lane chain check (no branches, linear sequence).
  const pitCells = (byLane.get(PIT_LANE) ?? []).map((c) => c.id);
  const pitSet = new Set(pitCells);
  for (const id of pitCells) {
    const cell = byId.get(id);
    const pitNext = (cell.next ?? []).filter((n) => pitSet.has(n));
    if (pitNext.length > 1) errors.push(`pit cell ${id} has multiple pit next links`);
  }

  // Pit lane length and connectivity (entry -> exit).
  if (pitEntry.length === 1 && pitExit.length === 1) {
    const entryId = pitEntry[0].id;
    const exitId = pitExit[0].id;
    const visited = new Set();
    let current = entryId;
    let steps = 0;
    while (!visited.has(current) && pitSet.has(current)) {
      visited.add(current);
      steps += 1;
      if (current === exitId) break;
      const cell = byId.get(current);
      const nextPit = (cell.next ?? []).find((n) => pitSet.has(n));
      if (!nextPit) break;
      current = nextPit;
    }
    if (current !== exitId) {
      errors.push(`pit chain does not reach PIT_EXIT from PIT_ENTRY`);
    } else if (steps !== pitCells.length) {
      errors.push(`pit lane length mismatch: chain has ${steps}, pit lane has ${pitCells.length}`);
    }
  }

  // Lane change constraints for main lanes.
  const mainLanes = new Set(MAIN_LANES);
  for (const cell of cells) {
    if (!mainLanes.has(cell.laneIndex)) continue;
    for (const nextId of cell.next ?? []) {
      const nextCell = byId.get(nextId);
      if (!nextCell) continue;
      if (nextCell.laneIndex === PIT_LANE) continue;
      const diff = Math.abs(nextCell.laneIndex - cell.laneIndex);
      if (diff > 1) {
        errors.push(`invalid lane change from ${cell.id} to ${nextId}`);
      }
    }
  }

  return errors;
}

const track = loadTrack(trackPath);
const errors = validateTrack(track);
if (errors.length === 0) {
  console.log(`OK: ${path.basename(trackPath)}`);
} else {
  fail(errors);
}
