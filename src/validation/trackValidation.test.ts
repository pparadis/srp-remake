import { describe, expect, it } from "vitest";
import track from "../../public/tracks/oval16_3lanes.json";
import type { TrackData } from "../game/types/track";
import { validateTrack } from "./trackValidation";

function cloneTrack(): TrackData {
  return JSON.parse(JSON.stringify(track)) as TrackData;
}

function getCell(copy: TrackData, id: string) {
  const cell = copy.cells.find((c) => c.id === id);
  if (!cell) throw new Error(`missing cell ${id} in test fixture`);
  return cell;
}

function removeTag(copy: TrackData, tag: "START_FINISH" | "PIT_ENTRY" | "PIT_BOX" | "PIT_EXIT") {
  for (const cell of copy.cells) {
    if (!cell.tags) continue;
    cell.tags = cell.tags.filter((t) => t !== tag);
  }
}

describe("trackValidation", () => {
  it("passes for the bundled track", () => {
    const errors = validateTrack(track as unknown as TrackData);
    expect(errors).toHaveLength(0);
  });

  it.each([
    {
      name: "duplicate ids",
      mutate: (copy: TrackData) => {
        copy.cells[1]!.id = copy.cells[0]!.id;
      },
      expected: "duplicate cell id"
    },
    {
      name: "invalid lane count",
      mutate: (copy: TrackData) => {
        copy.lanes = 3;
      },
      expected: "track.lanes must be 4"
    },
    {
      name: "invalid lane index",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z01_L1_00").laneIndex = 4;
      },
      expected: "invalid laneIndex 4"
    },
    {
      name: "invalid zone index",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z01_L1_00").zoneIndex = 0;
      },
      expected: "invalid zoneIndex 0"
    },
    {
      name: "invalid forward index",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z01_L1_00").forwardIndex = -1;
      },
      expected: "invalid forwardIndex -1"
    },
    {
      name: "missing next cell reference",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z01_L1_00").next.push("MISSING_CELL");
      },
      expected: "missing next cell MISSING_CELL"
    },
    {
      name: "non contiguous zone indices in a main lane",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z03_L2_00").zoneIndex = 100;
      },
      expected: "lane 2 zone indices not contiguous"
    },
    {
      name: "missing spine lane",
      mutate: (copy: TrackData) => {
        for (const cell of copy.cells) {
          if (cell.laneIndex === 1) cell.laneIndex = 2;
        }
      },
      expected: "spine lane 1 has no cells"
    },
    {
      name: "missing spine start/finish tag",
      mutate: (copy: TrackData) => {
        removeTag(copy, "START_FINISH");
      },
      expected: "spine lane must have exactly 1 START_FINISH, got 0"
    },
    {
      name: "non contiguous spine forward index",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z02_L1_00").forwardIndex = 20;
      },
      expected: "spine lane forwardIndex not contiguous"
    },
    {
      name: "forward index outside spine range",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z02_L0_00").forwardIndex = 999;
      },
      expected: "forwardIndex 999 out of spine range"
    },
    {
      name: "missing pit entry",
      mutate: (copy: TrackData) => {
        removeTag(copy, "PIT_ENTRY");
      },
      expected: "expected 1 PIT_ENTRY, got 0"
    },
    {
      name: "missing pit exit",
      mutate: (copy: TrackData) => {
        removeTag(copy, "PIT_EXIT");
      },
      expected: "expected 1 PIT_EXIT, got 0"
    },
    {
      name: "pit entry in wrong lane",
      mutate: (copy: TrackData) => {
        const entry = copy.cells.find((c) => (c.tags ?? []).includes("PIT_ENTRY"));
        if (!entry) throw new Error("missing PIT_ENTRY fixture");
        entry.laneIndex = 1;
      },
      expected: "PIT_ENTRY must be in lane 0"
    },
    {
      name: "pit exit in wrong lane",
      mutate: (copy: TrackData) => {
        const pitExit = copy.cells.find((c) => (c.tags ?? []).includes("PIT_EXIT"));
        if (!pitExit) throw new Error("missing PIT_EXIT fixture");
        pitExit.laneIndex = 1;
      },
      expected: "PIT_EXIT must be in lane 0"
    },
    {
      name: "pit box in wrong lane",
      mutate: (copy: TrackData) => {
        const pitBox = copy.cells.find((c) => (c.tags ?? []).includes("PIT_BOX"));
        if (!pitBox) throw new Error("missing PIT_BOX fixture");
        pitBox.laneIndex = 1;
      },
      expected: "PIT_BOX must be in lane 0"
    },
    {
      name: "spine next monotonicity jump",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z01_L1_00").next = ["Z03_L1_00"];
      },
      expected: "spine forwardIndex jump"
    },
    {
      name: "pit lane branching",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z02_L0_00").next = ["Z03_L0_00", "Z04_L0_00"];
      },
      expected: "has multiple pit next links"
    },
    {
      name: "pit chain disconnected from exit",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z03_L0_00").next = ["Z07_L1_00"];
      },
      expected: "pit chain does not reach PIT_EXIT from PIT_ENTRY"
    },
    {
      name: "pit chain length mismatch",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z03_L0_00").next = ["Z05_L0_00"];
      },
      expected: "pit lane length mismatch"
    },
    {
      name: "invalid lane change skipping an adjacent lane",
      mutate: (copy: TrackData) => {
        getCell(copy, "Z05_L1_00").next.push("Z06_L3_00");
      },
      expected: "invalid lane change"
    }
  ])("flags %s", ({ mutate, expected }) => {
    const copy = cloneTrack();
    mutate(copy);
    const errors = validateTrack(copy);
    expect(errors.some((e) => e.includes(expected))).toBe(true);
  });
});
