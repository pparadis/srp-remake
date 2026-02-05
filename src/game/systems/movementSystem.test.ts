import { describe, expect, it } from "vitest";
import { computeValidTargets } from "./movementSystem";
import { buildTrackIndex } from "./trackIndex";
import type { TrackData } from "../types/track";
import track from "../../../public/tracks/oval16_3lanes.json";

function makeTrack(): TrackData {
  return {
    trackId: "test",
    zones: 2,
    lanes: 4,
    cells: [
      { id: "A0", zoneIndex: 1, laneIndex: 0, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0", "B1", "P1"] },
      { id: "A1", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B0", "B1", "B2"] },
      { id: "A2", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B1", "B2"] },
      { id: "B0", zoneIndex: 2, laneIndex: 0, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["A0", "A1"] },
      { id: "B1", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["A0", "A1", "A2"] },
      { id: "B2", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["A1", "A2"] },
      { id: "P1", zoneIndex: 1, laneIndex: 3, forwardIndex: 0, pos: { x: 0, y: -1 }, next: ["P2"], tags: ["PIT_ENTRY"] },
      { id: "P2", zoneIndex: 2, laneIndex: 3, forwardIndex: 1, pos: { x: 1, y: -1 }, next: ["B0"], tags: ["PIT_EXIT"] }
    ]
  };
}

describe("computeValidTargets", () => {
  it("disallows pit entry from non-lane0", () => {
    const track = makeTrack();
    const targets = computeValidTargets(buildTrackIndex(track), "A1", new Set(), 2, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("P1")).toBe(false);
  });

  it("allows pit entry from lane0", () => {
    const track = makeTrack();
    const targets = computeValidTargets(buildTrackIndex(track), "A0", new Set(), 2, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("P1")).toBe(true);
  });

  it("limits pit lane movement to 1 step", () => {
    const track = makeTrack();
    const targets = computeValidTargets(buildTrackIndex(track), "P1", new Set(), 9, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("P2")).toBe(true);
    expect(targets.size).toBe(1);
  });

  it("prevents lane changes beyond adjacent lanes", () => {
    const track = makeTrack();
    const targets = computeValidTargets(buildTrackIndex(track), "A0", new Set(), 1, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("B2")).toBe(false);
  });

  it("allows lane change past same-lane block", () => {
    const track = makeTrack();
    const occupied = new Set(["B2"]);
    const targets = computeValidTargets(buildTrackIndex(track), "A2", occupied, 2, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("B1")).toBe(true);
  });

  it("allows passing when target lane is clear", () => {
    const track: TrackData = {
      trackId: "test-3",
      zones: 3,
      lanes: 4,
      cells: [
        { id: "A0", zoneIndex: 1, laneIndex: 0, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0", "B1"] },
        { id: "A1", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B0", "B1", "B2"] },
        { id: "A2", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B1", "B2"] },
        { id: "B0", zoneIndex: 2, laneIndex: 0, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["C0", "C1"] },
        { id: "B1", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["C0", "C1", "C2"] },
        { id: "B2", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["C1", "C2"] },
        { id: "C0", zoneIndex: 3, laneIndex: 0, forwardIndex: 2, pos: { x: 2, y: 0 }, next: ["A0", "A1"] },
        { id: "C1", zoneIndex: 3, laneIndex: 1, forwardIndex: 2, pos: { x: 2, y: 1 }, next: ["A0", "A1", "A2"] },
        { id: "C2", zoneIndex: 3, laneIndex: 2, forwardIndex: 2, pos: { x: 2, y: 2 }, next: ["A1", "A2"] }
      ]
    };
    const occupied = new Set(["B0"]);
    const targets = computeValidTargets(buildTrackIndex(track), "A1", occupied, 2, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("B1")).toBe(true);
    expect(targets.has("B2")).toBe(true);
    expect(targets.has("C1")).toBe(true);
    expect(targets.has("C2")).toBe(true);
  });

  it("allows lane change to pass blocked lane on real track", () => {
    const occupied = new Set(["Z11_L1_00"]);
    const targets = computeValidTargets(buildTrackIndex(track as TrackData), "Z10_L1_00", occupied, 2, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("Z12_L1_00")).toBe(false);
    expect(targets.has("Z12_L2_00")).toBe(true);
  });

  it("allows pit exit to lane 0 on real track", () => {
    const occupied = new Set<string>();
    const targets = computeValidTargets(buildTrackIndex(track as TrackData), "Z06_L3_00", occupied, 1, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("Z07_L0_00")).toBe(true);
  });

  it("disallows sideways lane change with no forward progress", () => {
    const occupied = new Set<string>();
    const targets = computeValidTargets(buildTrackIndex(track as TrackData), "Z01_L0_00", occupied, 1, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("Z01_L1_00")).toBe(false);
    expect(targets.has("Z02_L0_00")).toBe(true);
  });

  it("allows selecting any PIT_BOX when adjacent to pit boxes", () => {
    const occupied = new Set<string>();
    const targets = computeValidTargets(buildTrackIndex(track as TrackData), "Z01_L3_00", occupied, 9, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("Z02_L3_00")).toBe(true);
    expect(targets.has("Z03_L3_00")).toBe(true);
  });

  it("only allows pit entry at distance 1", () => {
    const occupied = new Set<string>();
    const targets = computeValidTargets(buildTrackIndex(track as TrackData), "Z26_L0_00", occupied, 9, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("Z28_L3_00")).toBe(false);
    expect(targets.has("Z01_L3_00")).toBe(false);
  });

  it("disallows pit box targets after service", () => {
    const occupied = new Set<string>();
    occupied.add("Z02_L3_00");
    const targets = computeValidTargets(
      buildTrackIndex(track as TrackData),
      "Z02_L3_00",
      occupied,
      1,
      { allowPitExitSkip: true, disallowPitBoxTargets: true },
      {
        tireRate: 0.5,
        fuelRate: 0.45,
        setup: {
          compound: "soft",
          psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
          wingFrontDeg: 6,
          wingRearDeg: 12
        }
      }
    );
    expect(targets.has("Z03_L3_00")).toBe(false);
  });

  it("blocks only by cars ahead in the target lane", () => {
    const track: TrackData = {
      trackId: "block-test",
      zones: 3,
      lanes: 4,
      cells: [
        { id: "A0", zoneIndex: 1, laneIndex: 0, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0", "B1"] },
        { id: "A1", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B0", "B1", "B2"] },
        { id: "A2", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B1", "B2"] },
        { id: "B0", zoneIndex: 2, laneIndex: 0, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["C0", "C1"] },
        { id: "B1", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["C0", "C1", "C2"] },
        { id: "B2", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["C1", "C2"] },
        { id: "C0", zoneIndex: 3, laneIndex: 0, forwardIndex: 2, pos: { x: 2, y: 0 }, next: ["A0", "A1"] },
        { id: "C1", zoneIndex: 3, laneIndex: 1, forwardIndex: 2, pos: { x: 2, y: 1 }, next: ["A0", "A1", "A2"] },
        { id: "C2", zoneIndex: 3, laneIndex: 2, forwardIndex: 2, pos: { x: 2, y: 2 }, next: ["A1", "A2"] }
      ]
    };
    const occupied = new Set(["B1"]);
    const targets = computeValidTargets(buildTrackIndex(track), "A1", occupied, 2, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("C1")).toBe(false);
    expect(targets.has("C2")).toBe(true);
  });

  it("does not block progress for cars ahead in adjacent lanes", () => {
    const track: TrackData = {
      trackId: "adjacent-block-test",
      zones: 3,
      lanes: 4,
      cells: [
        { id: "A0", zoneIndex: 1, laneIndex: 0, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0", "B1"] },
        { id: "A1", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B0", "B1", "B2"] },
        { id: "A2", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B1", "B2"] },
        { id: "B0", zoneIndex: 2, laneIndex: 0, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["C0", "C1"] },
        { id: "B1", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["C0", "C1", "C2"] },
        { id: "B2", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["C1", "C2"] },
        { id: "C0", zoneIndex: 3, laneIndex: 0, forwardIndex: 2, pos: { x: 2, y: 0 }, next: ["A0", "A1"] },
        { id: "C1", zoneIndex: 3, laneIndex: 1, forwardIndex: 2, pos: { x: 2, y: 1 }, next: ["A0", "A1", "A2"] },
        { id: "C2", zoneIndex: 3, laneIndex: 2, forwardIndex: 2, pos: { x: 2, y: 2 }, next: ["A1", "A2"] }
      ]
    };
    const occupied = new Set(["B2"]);
    const targets = computeValidTargets(buildTrackIndex(track), "A1", occupied, 2, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("C1")).toBe(true);
  });

  it("applies lane cost factors for tire and fuel", () => {
    const track: TrackData = {
      trackId: "cost-test",
      zones: 2,
      lanes: 4,
      cells: [
        { id: "A0", zoneIndex: 1, laneIndex: 0, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0"] },
        { id: "A1", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B1"] },
        { id: "A2", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B2"] },
        { id: "B0", zoneIndex: 2, laneIndex: 0, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["A0"] },
        { id: "B1", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["A1"] },
        { id: "B2", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["A2"] }
      ]
    };
    const costs = { tireRate: 100, fuelRate: 100, setup: {
      compound: "soft" as const,
      psi: { fl: 32, fr: 32, rl: 32, rr: 32 },
      wingFrontDeg: 0,
      wingRearDeg: 0
    }};
    const targets0 = computeValidTargets(buildTrackIndex(track), "A0", new Set(), 1, {}, costs);
    const targets1 = computeValidTargets(buildTrackIndex(track), "A1", new Set(), 1, {}, costs);
    const targets2 = computeValidTargets(buildTrackIndex(track), "A2", new Set(), 1, {}, costs);
    const lane0 = targets0.get("B0");
    const lane1 = targets1.get("B1");
    const lane2 = targets2.get("B2");
    expect(Boolean(lane0 && lane1 && lane2)).toBe(true);
    if (!lane0 || !lane1 || !lane2) return;
    expect(lane0.tireCost).toBeGreaterThan(lane1.tireCost);
    expect(lane1.tireCost).toBeGreaterThan(lane2.tireCost);
    expect(lane0.fuelCost).toBeLessThan(lane1.fuelCost);
    expect(lane1.fuelCost).toBeLessThan(lane2.fuelCost);
  });
});
