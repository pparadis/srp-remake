import { describe, expect, it } from "vitest";
import { buildTrackIndex } from "../../src/game/systems/trackIndex";
import type { TrackCell } from "../../src/game/types/track";
import { drawBend } from "./bend";
import { priceBar } from "./priceBar";
import { drawRoute, stepsOf } from "./route";
import { esc, text } from "./svg";

// Two zones, three lanes; forwardIndex does not move on the lane-2 cell of zone 1 (a sideways landing).
const cell = (id: string, zone: number, lane: number, fwd: number): TrackCell => ({
  id,
  zoneIndex: zone,
  laneIndex: lane,
  forwardIndex: fwd,
  pos: { x: zone, y: lane },
  next: []
});
const cells = [cell("A1", 1, 1, 0), cell("A2", 1, 2, 0), cell("A3", 1, 3, 0), cell("B1", 2, 1, 1), cell("B2", 2, 2, 1), cell("B3", 2, 3, 1)];
const trackIndex = buildTrackIndex({ trackId: "t", zones: 2, lanes: 4, cells });

describe("svg", () => {
  it("escapes text", () => {
    expect(esc(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
    expect(text(0, 0, "<b>")).toContain("&lt;b&gt;");
  });
});

describe("drawBend", () => {
  it("puts zones left to right and lane 3 on top, with the forwardIndex in each dot", () => {
    const bend = drawBend(trackIndex, [1, 2], { x: 100, y: 50, zoneStep: 100, laneStep: 40 });
    expect(bend.cellPos.get("A1")).toEqual({ x: 100, y: 130 });
    expect(bend.cellPos.get("B3")).toEqual({ x: 200, y: 50 });
    expect(bend.svg).toContain(">1</text>");
  });
});

describe("stepsOf", () => {
  it("tells sideways, forward and diagonal steps apart", () => {
    const steps = stepsOf(["A1", "A2", "B2", "B1"], trackIndex);
    expect(steps.map((s) => s.kind)).toEqual(["sideways", "forward", "sideways"]);
    expect(stepsOf(["A1", "B2"], trackIndex)[0]!.kind).toBe("diagonal");
  });
  it("draws one numbered arrow per step", () => {
    const bend = drawBend(trackIndex, [1, 2], { x: 100, y: 50, zoneStep: 100, laneStep: 40 });
    const svg = drawRoute(stepsOf(["A1", "A2", "B2"], trackIndex), bend.cellPos);
    expect(svg.match(/<polygon/g)).toHaveLength(2);
  });
});

describe("priceBar", () => {
  it("labels each segment and the total, and hatches a part the code does not charge", () => {
    const svg = priceBar(0, 0, [
      { label: "2 fwd", value: 2, color: "#111" },
      { label: "+0", value: 1, color: "#222", hatched: true }
    ], 2, "#333");
    expect(svg).toContain("2 fwd");
    expect(svg).toContain("url(#hatch)");
    expect(svg).toContain("= 2");
  });
});
