import { describe, expect, it } from "vitest";
import { computeSqueezeTargets, computeValidTargets } from "./movementSystem";
import { buildTrackIndex } from "./trackIndex";
import type { TrackData } from "../types/track";
import track from "../../../public/tracks/oval16_3lanes.json";

function makeTrack(): TrackData {
  return {
    trackId: "test",
    zones: 2,
    lanes: 4,
    cells: [
      { id: "A0", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0", "B1", "P1"] },
      { id: "A1", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B0", "B1", "B2"] },
      { id: "A2", zoneIndex: 1, laneIndex: 3, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B1", "B2"] },
      { id: "B0", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["A0", "A1"] },
      { id: "B1", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["A0", "A1", "A2"] },
      { id: "B2", zoneIndex: 2, laneIndex: 3, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["A1", "A2"] },
      { id: "P1", zoneIndex: 1, laneIndex: 0, forwardIndex: 0, pos: { x: 0, y: -1 }, next: ["P2"], tags: ["PIT_ENTRY"] },
      { id: "P2", zoneIndex: 2, laneIndex: 0, forwardIndex: 1, pos: { x: 1, y: -1 }, next: ["B0"], tags: ["PIT_EXIT"] }
    ]
  };
}

describe("computeValidTargets", () => {
  it("disallows pit entry from non-inner lane", () => {
    const track = makeTrack();
    const targets = computeValidTargets(buildTrackIndex(track), "A1", new Set(), 2, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("P1")).toBe(false);
  });

  it("allows pit entry from inner lane", () => {
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
        { id: "A0", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0", "B1"] },
        { id: "A1", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B0", "B1", "B2"] },
        { id: "A2", zoneIndex: 1, laneIndex: 3, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B1", "B2"] },
        { id: "B0", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["C0", "C1"] },
        { id: "B1", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["C0", "C1", "C2"] },
        { id: "B2", zoneIndex: 2, laneIndex: 3, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["C1", "C2"] },
        { id: "C0", zoneIndex: 3, laneIndex: 1, forwardIndex: 2, pos: { x: 2, y: 0 }, next: ["A0", "A1"] },
        { id: "C1", zoneIndex: 3, laneIndex: 2, forwardIndex: 2, pos: { x: 2, y: 1 }, next: ["A0", "A1", "A2"] },
        { id: "C2", zoneIndex: 3, laneIndex: 3, forwardIndex: 2, pos: { x: 2, y: 2 }, next: ["A1", "A2"] }
      ]
    };
    const occupied = new Set(["B0"]);
    const targets = computeValidTargets(buildTrackIndex(track), "A1", occupied, 3, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
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

  it("blocks same-lane passing but still allows lane-change passing on real track", () => {
    const occupied = new Set(["Z11_L1_00"]);
    const targets = computeValidTargets(buildTrackIndex(track as TrackData), "Z10_L1_00", occupied, 3, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("Z12_L1_00")).toBe(false);
    expect(targets.has("Z12_L2_00")).toBe(true);
  });

  it("allows pit exit to lane 1 on real track", () => {
    const occupied = new Set<string>();
    const targets = computeValidTargets(buildTrackIndex(track as TrackData), "Z06_L0_00", occupied, 1, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("Z07_L1_00")).toBe(true);
  });

  it("disallows sideways lane change with no forward progress", () => {
    const occupied = new Set<string>();
    const targets = computeValidTargets(buildTrackIndex(track as TrackData), "Z01_L1_00", occupied, 1, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("Z01_L2_00")).toBe(false);
    expect(targets.has("Z02_L1_00")).toBe(true);
  });

  it("allows selecting any PIT_BOX when adjacent to pit boxes", () => {
    const occupied = new Set<string>();
    const targets = computeValidTargets(buildTrackIndex(track as TrackData), "Z01_L0_00", occupied, 9, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("Z02_L0_00")).toBe(true);
    expect(targets.has("Z03_L0_00")).toBe(true);
  });

  it("only allows pit entry at distance 1", () => {
    const occupied = new Set<string>();
    const targets = computeValidTargets(buildTrackIndex(track as TrackData), "Z26_L1_00", occupied, 9, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("Z28_L0_00")).toBe(false);
    expect(targets.has("Z01_L0_00")).toBe(false);
  });

  it("disallows pit box targets after service", () => {
    const occupied = new Set<string>();
    occupied.add("Z02_L0_00");
    const targets = computeValidTargets(
      buildTrackIndex(track as TrackData),
      "Z02_L0_00",
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
    expect(targets.has("Z03_L0_00")).toBe(false);
  });

  it("blocks farther targets in target lane when intermediate cells are occupied", () => {
    const track: TrackData = {
      trackId: "block-test",
      zones: 3,
      lanes: 4,
      cells: [
        { id: "A0", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0", "B1"] },
        { id: "A1", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B0", "B1", "B2"] },
        { id: "A2", zoneIndex: 1, laneIndex: 3, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B1", "B2"] },
        { id: "B0", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["C0", "C1"] },
        { id: "B1", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["C0", "C1", "C2"] },
        { id: "B2", zoneIndex: 2, laneIndex: 3, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["C1", "C2"] },
        { id: "C0", zoneIndex: 3, laneIndex: 1, forwardIndex: 2, pos: { x: 2, y: 0 }, next: ["A0", "A1"] },
        { id: "C1", zoneIndex: 3, laneIndex: 2, forwardIndex: 2, pos: { x: 2, y: 1 }, next: ["A0", "A1", "A2"] },
        { id: "C2", zoneIndex: 3, laneIndex: 3, forwardIndex: 2, pos: { x: 2, y: 2 }, next: ["A1", "A2"] }
      ]
    };
    const occupied = new Set(["B1"]);
    const targets = computeValidTargets(buildTrackIndex(track), "A1", occupied, 3, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("C1")).toBe(false);
    expect(targets.has("C2")).toBe(true);
  });

  it("blocks lane-change targets beyond nearest occupied car in destination lane", () => {
    const track: TrackData = {
      trackId: "target-lane-block-test",
      zones: 3,
      lanes: 4,
      cells: [
        { id: "A0", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0", "B1"] },
        { id: "A1", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B0", "B1", "B2"] },
        { id: "A2", zoneIndex: 1, laneIndex: 3, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B1", "B2"] },
        { id: "B0", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["C0", "C1"] },
        { id: "B1", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["C0", "C1", "C2"] },
        { id: "B2", zoneIndex: 2, laneIndex: 3, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["C1", "C2"] },
        { id: "C0", zoneIndex: 3, laneIndex: 1, forwardIndex: 2, pos: { x: 2, y: 0 }, next: ["A0", "A1"] },
        { id: "C1", zoneIndex: 3, laneIndex: 2, forwardIndex: 2, pos: { x: 2, y: 1 }, next: ["A0", "A1", "A2"] },
        { id: "C2", zoneIndex: 3, laneIndex: 3, forwardIndex: 2, pos: { x: 2, y: 2 }, next: ["A1", "A2"] }
      ]
    };
    const occupied = new Set(["B1"]);
    const targets = computeValidTargets(buildTrackIndex(track), "A0", occupied, 3, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("C0")).toBe(true);
    expect(targets.has("C1")).toBe(false);
  });

  it("does not traverse through occupied cells to reach farther targets", () => {
    const track: TrackData = {
      trackId: "gap-merge-test",
      zones: 5,
      lanes: 4,
      cells: [
        { id: "A0", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0", "B1"] },
        { id: "B0", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["C0", "C1"] },
        { id: "C0", zoneIndex: 3, laneIndex: 1, forwardIndex: 2, pos: { x: 2, y: 0 }, next: ["D0", "D1"] },
        { id: "D0", zoneIndex: 4, laneIndex: 1, forwardIndex: 3, pos: { x: 3, y: 0 }, next: ["E0", "E1"] },
        { id: "E0", zoneIndex: 5, laneIndex: 1, forwardIndex: 4, pos: { x: 4, y: 0 }, next: ["A0", "A1"] },
        { id: "A1", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B1"] },
        { id: "B1", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["C1"] },
        { id: "C1", zoneIndex: 3, laneIndex: 2, forwardIndex: 2, pos: { x: 2, y: 1 }, next: ["D1"] },
        { id: "D1", zoneIndex: 4, laneIndex: 2, forwardIndex: 3, pos: { x: 3, y: 1 }, next: ["E1"] },
        { id: "E1", zoneIndex: 5, laneIndex: 2, forwardIndex: 4, pos: { x: 4, y: 1 }, next: ["A1"] },
        { id: "A2", zoneIndex: 1, laneIndex: 3, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B2"] },
        { id: "B2", zoneIndex: 2, laneIndex: 3, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["C2"] },
        { id: "C2", zoneIndex: 3, laneIndex: 3, forwardIndex: 2, pos: { x: 2, y: 2 }, next: ["D2"] },
        { id: "D2", zoneIndex: 4, laneIndex: 3, forwardIndex: 3, pos: { x: 3, y: 2 }, next: ["E2"] },
        { id: "E2", zoneIndex: 5, laneIndex: 3, forwardIndex: 4, pos: { x: 4, y: 2 }, next: ["A2"] }
      ]
    };
    const occupied = new Set(["B0", "B1", "D1"]);
    const targets = computeValidTargets(buildTrackIndex(track), "A0", occupied, 4, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("C1")).toBe(false);
    expect(targets.has("E1")).toBe(false);
  });

  it("does not block progress for cars ahead in adjacent lanes", () => {
    const track: TrackData = {
      trackId: "adjacent-block-test",
      zones: 3,
      lanes: 4,
      cells: [
        { id: "A0", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0", "B1"] },
        { id: "A1", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B0", "B1", "B2"] },
        { id: "A2", zoneIndex: 1, laneIndex: 3, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B1", "B2"] },
        { id: "B0", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["C0", "C1"] },
        { id: "B1", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["C0", "C1", "C2"] },
        { id: "B2", zoneIndex: 2, laneIndex: 3, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["C1", "C2"] },
        { id: "C0", zoneIndex: 3, laneIndex: 1, forwardIndex: 2, pos: { x: 2, y: 0 }, next: ["A0", "A1"] },
        { id: "C1", zoneIndex: 3, laneIndex: 2, forwardIndex: 2, pos: { x: 2, y: 1 }, next: ["A0", "A1", "A2"] },
        { id: "C2", zoneIndex: 3, laneIndex: 3, forwardIndex: 2, pos: { x: 2, y: 2 }, next: ["A1", "A2"] }
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

  it("reduces lane-change reach when move spend surcharge applies", () => {
    const track: TrackData = {
      trackId: "lane-change-spend-test",
      zones: 3,
      lanes: 4,
      cells: [
        { id: "A0", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0", "B1"] },
        { id: "A1", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B0", "B1", "B2"] },
        { id: "A2", zoneIndex: 1, laneIndex: 3, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B1", "B2"] },
        { id: "B0", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["C0", "C1"] },
        { id: "B1", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["C0", "C1", "C2"] },
        { id: "B2", zoneIndex: 2, laneIndex: 3, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["C1", "C2"] },
        { id: "C0", zoneIndex: 3, laneIndex: 1, forwardIndex: 2, pos: { x: 2, y: 0 }, next: ["A0", "A1"] },
        { id: "C1", zoneIndex: 3, laneIndex: 2, forwardIndex: 2, pos: { x: 2, y: 1 }, next: ["A0", "A1", "A2"] },
        { id: "C2", zoneIndex: 3, laneIndex: 3, forwardIndex: 2, pos: { x: 2, y: 2 }, next: ["A1", "A2"] }
      ]
    };
    const targets = computeValidTargets(buildTrackIndex(track), "A1", new Set(), 2, {}, { tireRate: 0.5, fuelRate: 0.45, setup: {
      compound: "soft",
      psi: { fl: 23, fr: 23, rl: 21, rr: 21 },
      wingFrontDeg: 6,
      wingRearDeg: 12
    }});
    expect(targets.has("C1")).toBe(true);
    expect(targets.has("C2")).toBe(false);
  });

  it("keeps move spend at 2 for Z01_L1_00 -> Z02_L2_00", () => {
    const targets = computeValidTargets(
      buildTrackIndex(track as TrackData),
      "Z01_L1_00",
      new Set(["Z01_L1_00", "Z01_L3_00"]),
      9,
      {},
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
    const target = targets.get("Z02_L2_00");
    expect(target?.distance).toBe(2);
    expect(target?.moveSpend).toBe(2);
  });

  it("applies lane cost factors for tire and fuel", () => {
    const track: TrackData = {
      trackId: "cost-test",
      zones: 2,
      lanes: 4,
      cells: [
        { id: "A0", zoneIndex: 1, laneIndex: 1, forwardIndex: 0, pos: { x: 0, y: 0 }, next: ["B0"] },
        { id: "A1", zoneIndex: 1, laneIndex: 2, forwardIndex: 0, pos: { x: 0, y: 1 }, next: ["B1"] },
        { id: "A2", zoneIndex: 1, laneIndex: 3, forwardIndex: 0, pos: { x: 0, y: 2 }, next: ["B2"] },
        { id: "B0", zoneIndex: 2, laneIndex: 1, forwardIndex: 1, pos: { x: 1, y: 0 }, next: ["A0"] },
        { id: "B1", zoneIndex: 2, laneIndex: 2, forwardIndex: 1, pos: { x: 1, y: 1 }, next: ["A1"] },
        { id: "B2", zoneIndex: 2, laneIndex: 3, forwardIndex: 1, pos: { x: 1, y: 2 }, next: ["A2"] }
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
    const inner = targets0.get("B0");
    const middle = targets1.get("B1");
    const outer = targets2.get("B2");
    expect(Boolean(inner && middle && outer)).toBe(true);
    if (!inner || !middle || !outer) return;
    expect(inner.tireCost).toBeGreaterThan(middle.tireCost);
    expect(middle.tireCost).toBeGreaterThan(outer.tireCost);
    expect(inner.fuelCost).toBeLessThan(middle.fuelCost);
    expect(middle.fuelCost).toBeLessThan(outer.fuelCost);
  });
});

describe("computeSqueezeTargets (boxed in)", () => {
  const index = buildTrackIndex(track as unknown as TrackData);
  const costs = {
    tireRate: 0.5,
    fuelRate: 0.45,
    setup: { compound: "soft" as const, psi: { fl: 23, fr: 23, rl: 21, rr: 21 }, wingFrontDeg: 6, wingRearDeg: 12 }
  };
  const START = "Z05_L2_00";
  // Blocker ahead in the own lane plus both neighbouring-lane cells ahead.
  const BOXED = new Set([START, "Z06_L2_00", "Z06_L1_00", "Z06_L3_00"]);
  const normal = (occ: Set<string>, max = 9) => computeValidTargets(index, START, occ, max, {}, costs);
  const squeeze = (occ: Set<string>, max = 9) => computeSqueezeTargets(index, START, occ, max, costs);

  it("has no normal targets but offers squeezes with the surcharge", () => {
    expect(normal(BOXED).size).toBe(0);
    const t = squeeze(BOXED);
    expect(t.size).toBeGreaterThan(0);
    // Same lane, 2 ahead: passes 1 car (2 + 2). Lane 1, 2 ahead: passes the own-lane and lane-1 blockers.
    expect(t.get("Z07_L2_00")).toMatchObject({ distance: 2, moveSpend: 4, squeezePassed: 1 });
    expect(t.get("Z07_L1_00")).toMatchObject({ distance: 3, moveSpend: 3 + 4, squeezePassed: 2 });
    // Beyond the blockers nobody is passed twice by the same lane (counted once).
    expect(t.get("Z08_L2_00")).toMatchObject({ moveSpend: 3 + 2, squeezePassed: 1 });
  });

  it("is limited by the remaining budget", () => {
    expect(squeeze(BOXED, 4).has("Z07_L2_00")).toBe(true);
    expect(squeeze(BOXED, 4).has("Z07_L1_00")).toBe(false);
    expect(squeeze(BOXED, 4).has("Z08_L2_00")).toBe(false);
    expect(squeeze(BOXED, 3).size).toBe(0);
  });

  it("is not needed when a normal target exists (only partly blocked)", () => {
    const partly = new Set([START, "Z06_L2_00", "Z06_L1_00"]);
    expect(normal(partly).size).toBeGreaterThan(0);
  });

  it("never lands on a car, in the pit lane, backwards or sideways, and always passes a car", () => {
    const t = squeeze(BOXED);
    const start = index.cellMap.get(START)!;
    for (const [id, info] of t) {
      const cell = index.cellMap.get(id)!;
      expect(BOXED.has(id)).toBe(false);
      expect(cell.laneIndex).not.toBe(0);
      expect(Math.abs(cell.laneIndex - start.laneIndex)).toBeLessThanOrEqual(1);
      expect((cell.forwardIndex - start.forwardIndex + index.spineLen) % index.spineLen).toBeGreaterThan(0);
      expect(info.squeezePassed).toBeGreaterThanOrEqual(1);
      expect(info.moveSpend).toBeLessThanOrEqual(9);
    }
  });
});

describe("computeSqueezeTargets (pit exit blocked)", () => {
  const index = buildTrackIndex(track as unknown as TrackData);
  const costs = {
    tireRate: 0.5,
    fuelRate: 0.45,
    setup: { compound: "soft" as const, psi: { fl: 23, fr: 23, rl: 21, rr: 21 }, wingFrontDeg: 6, wingRearDeg: 12 }
  };
  const EXIT = "Z06_L0_00";
  const normal = (from: string, occ: Set<string>, max = 9) => computeValidTargets(index, from, occ, max, {}, costs);
  const squeeze = (from: string, occ: Set<string>, max = 9) => computeSqueezeTargets(index, from, occ, max, costs);

  it("is boxed in with Z07_L1_00 taken and squeezes onto lane 1 with the surcharge", () => {
    const occ = new Set([EXIT, "Z07_L1_00"]);
    expect(normal(EXIT, occ).size).toBe(0);
    const t = squeeze(EXIT, occ);
    expect([...t.keys()].sort()).toEqual(["Z08_L1_00", "Z09_L1_00"]);
    expect(t.get("Z08_L1_00")).toMatchObject({ distance: 2, moveSpend: 4, squeezePassed: 1, isPitTrigger: false });
    expect(t.get("Z09_L1_00")).toMatchObject({ distance: 3, moveSpend: 5, squeezePassed: 1 });
  });

  it("counts every car on the path and never lands on one", () => {
    const occ = new Set([EXIT, "Z07_L1_00", "Z08_L1_00"]);
    const t = squeeze(EXIT, occ);
    expect([...t.keys()]).toEqual(["Z09_L1_00"]);
    expect(t.get("Z09_L1_00")).toMatchObject({ distance: 3, moveSpend: 7, squeezePassed: 2 });
    expect(squeeze(EXIT, occ, 6).size).toBe(0);
  });

  it("never offers pit cells, other lanes or cells beyond 3 away", () => {
    const t = squeeze(EXIT, new Set([EXIT, "Z07_L1_00", "Z09_L1_00"]));
    expect([...t.keys()]).toEqual(["Z08_L1_00"]);
    for (const id of t.keys()) expect(index.cellMap.get(id)!.laneIndex).toBe(1);
  });

  it("offers nothing from other pit cells and nothing when the exit is free", () => {
    expect(squeeze("Z05_L0_00", new Set(["Z05_L0_00", EXIT])).size).toBe(0);
    expect(squeeze("Z02_L0_00", new Set(["Z02_L0_00", "Z03_L0_00"])).size).toBe(0);
    const free = new Set([EXIT]);
    expect([...normal(EXIT, free).keys()]).toEqual(["Z07_L1_00"]);
    expect(squeeze(EXIT, free).size).toBe(0);
  });
});
