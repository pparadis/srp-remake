import fs from "node:fs";
import path from "node:path";

const trackPath = process.argv[2] ?? path.join(process.cwd(), "public", "tracks", "oval16_3lanes.json");

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
  for (const lane of [0, 1, 2]) {
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

  // Pit invariants.
  const pitEntry = cells.filter((c) => (c.tags ?? []).includes("PIT_ENTRY"));
  const pitExit = cells.filter((c) => (c.tags ?? []).includes("PIT_EXIT"));
  if (pitEntry.length !== 1) errors.push(`expected 1 PIT_ENTRY, got ${pitEntry.length}`);
  if (pitExit.length !== 1) errors.push(`expected 1 PIT_EXIT, got ${pitExit.length}`);
  for (const c of pitEntry) {
    if (c.laneIndex !== 3) errors.push(`PIT_ENTRY must be in lane 3: ${c.id}`);
  }
  for (const c of pitExit) {
    if (c.laneIndex !== 3) errors.push(`PIT_EXIT must be in lane 3: ${c.id}`);
  }
  for (const c of cells) {
    if ((c.tags ?? []).includes("PIT_BOX") && c.laneIndex !== 3) {
      errors.push(`PIT_BOX must be in lane 3: ${c.id}`);
    }
  }

  // Pit lane chain check (no branches, linear sequence).
  const pitCells = (byLane.get(3) ?? []).map((c) => c.id);
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
  const mainLanes = new Set([0, 1, 2]);
  for (const cell of cells) {
    if (!mainLanes.has(cell.laneIndex)) continue;
    for (const nextId of cell.next ?? []) {
      const nextCell = byId.get(nextId);
      if (!nextCell) continue;
      if (nextCell.laneIndex === 3) continue;
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
