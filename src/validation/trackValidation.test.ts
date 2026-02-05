import { describe, expect, it } from "vitest";
import track from "../../public/tracks/oval16_3lanes.json";
import type { TrackData } from "../game/types/track";
import { validateTrack } from "./trackValidation";

describe("trackValidation", () => {
  it("passes for the bundled track", () => {
    const errors = validateTrack(track as unknown as TrackData);
    expect(errors).toHaveLength(0);
  });

  it("flags missing PIT_ENTRY", () => {
    const copy = JSON.parse(JSON.stringify(track)) as TrackData;
    const entry = copy.cells.find((c) => (c.tags ?? []).includes("PIT_ENTRY"));
    if (entry?.tags) {
      entry.tags = entry.tags.filter((t) => t !== "PIT_ENTRY");
    }
    const errors = validateTrack(copy);
    expect(errors.some((e) => e.includes("expected 1 PIT_ENTRY"))).toBe(true);
  });
});
