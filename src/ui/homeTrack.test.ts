/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import track from "../../public/tracks/oval16_3lanes.json";
import type { TrackData } from "../game/types/track";
import { laneCells, pitLapPoints, renderHomeTrack, setHomeTrackRunning } from "./homeTrack";

const TRACK = track as unknown as TrackData;
let svg: SVGSVGElement;

const pathPoints = (d: string) =>
  [...d.matchAll(/(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }));
const q = <T extends Element>(selector: string) => [...svg.querySelectorAll<T>(selector)];

beforeEach(() => {
  svg = document.createElementNS("http://www.w3.org/2000/svg", "svg") as SVGSVGElement;
  document.body.replaceChildren(svg);
});

describe("renderHomeTrack", () => {
  it("draws one closed path per main lane and a dashed open one for the pit lane", () => {
    renderHomeTrack(svg);
    expect(q("path.home-lane[id]").map((p) => p.id)).toEqual(["home-lane-1", "home-lane-2", "home-lane-3", "home-pit"]);
    for (const lane of [1, 2, 3]) expect(svg.querySelector(`#home-lane-${lane}`)!.getAttribute("d")).toMatch(/ Z$/);
    expect(svg.querySelector("#home-pit")!.getAttribute("d")).not.toMatch(/Z$/);
    expect(svg.querySelector("#home-pit")!.classList.contains("home-lane-pit")).toBe(true);
  });

  it("links the pit lane to lane 1 at the entry and at the exit", () => {
    renderHomeTrack(svg);
    const links = q("path.home-lane-pit:not(#home-pit)").map((p) => pathPoints(p.getAttribute("d")!));
    expect(links).toEqual([
      [{ x: 820, y: 470 }, { x: 755, y: 426 }], // lane 1 -> PIT_ENTRY
      [{ x: 365, y: 426 }, { x: 300, y: 470 }] // PIT_EXIT -> lane 1
    ]);
  });

  it("follows the lanes in forwardIndex order", () => {
    renderHomeTrack(svg);
    for (const [lane, id] of [[1, "home-lane-1"], [2, "home-lane-2"], [3, "home-lane-3"], [0, "home-pit"]] as const) {
      const expected = TRACK.cells.filter((c) => c.laneIndex === lane).sort((a, b) => a.forwardIndex - b.forwardIndex).map((c) => c.pos);
      expect(pathPoints(svg.querySelector(`#${id}`)!.getAttribute("d")!)).toEqual(expected);
    }
    expect(laneCells(TRACK, 1)[0]!.forwardIndex).toBe(0);
  });

  it("sets a viewBox that covers every cell", () => {
    renderHomeTrack(svg);
    const [x, y, w, h] = svg.getAttribute("viewBox")!.split(" ").map(Number) as [number, number, number, number];
    for (const { pos } of TRACK.cells) {
      expect(pos.x).toBeGreaterThanOrEqual(x);
      expect(pos.x).toBeLessThanOrEqual(x + w);
      expect(pos.y).toBeGreaterThanOrEqual(y);
      expect(pos.y).toBeLessThanOrEqual(y + h);
    }
  });

  it("puts the start line across all lanes of the start zone, the pit lane included", () => {
    renderHomeTrack(svg);
    const line = svg.querySelector("line.home-start")!;
    const ys = TRACK.cells.filter((c) => c.zoneIndex === 1).map((c) => c.pos.y);
    expect(Number(line.getAttribute("x1"))).toBe(690);
    expect(Number(line.getAttribute("y1"))).toBeLessThanOrEqual(Math.min(...ys));
    expect(Number(line.getAttribute("y2"))).toBeGreaterThanOrEqual(Math.max(...ys));
  });

  it("runs three cars along paths that exist, at their own speeds, the first one also through the pits", () => {
    renderHomeTrack(svg);
    const cars = q<SVGGElement>("g.home-car");
    expect(cars).toHaveLength(3);
    const refs = cars.map((car) => car.querySelector("mpath")!.getAttribute("href")!.slice(1));
    expect(refs).toEqual(["home-pit-lap", "home-lane-2", "home-lane-3"]);
    for (const id of refs) expect(svg.querySelector(`#${id}`)).not.toBeNull();
    const durations = cars.map((car) => car.querySelector("animateMotion")!.getAttribute("dur"));
    expect(new Set(durations).size).toBe(3);
    expect(cars.map((car) => car.querySelector("image")!.getAttribute("href"))).toEqual([
      "/assets/kenney/car-red.png",
      "/assets/kenney/car-blue.png",
      "/assets/kenney/car-yellow.png"
    ]);
  });

  it("the pit lap runs a normal lap, then lane 1 to the pit entry, the whole pit lane, and back to where it began", () => {
    renderHomeTrack(svg);
    const lap = pathPoints(svg.querySelector("#home-pit-lap")!.getAttribute("d")!);
    const pit = laneCells(TRACK, 0).map((c) => c.pos);
    expect(lap.slice(-pit.length)).toEqual(pit);
    const rejoin = TRACK.cells.find((c) => c.id === "Z07_L1_00")!.pos;
    expect(lap[0]).toEqual(rejoin); // starts where the pit exit rejoins lane 1
    expect(lap.filter((p) => p.x === rejoin.x && p.y === rejoin.y)).toHaveLength(2); // once per lap
    expect(lap).toHaveLength(laneCells(TRACK, 1).length + pitLapPoints(TRACK)!.length);
  });

  it("without a pit lane the first car just laps lane 1", () => {
    const noPit = { ...TRACK, cells: TRACK.cells.filter((c) => c.laneIndex !== 0) };
    expect(pitLapPoints(noPit)).toBeNull();
    renderHomeTrack(svg, noPit);
    expect(svg.querySelector("#home-pit")).toBeNull();
    expect(q("mpath")[0]!.getAttribute("href")).toBe("#home-lane-1");
  });

  it("re-rendering replaces the drawing instead of stacking it", () => {
    renderHomeTrack(svg);
    renderHomeTrack(svg);
    expect(q("g.home-car")).toHaveLength(3);
    expect(q("path.home-lane")).toHaveLength(6); // 3 lanes, the pit lane and its 2 links
  });

  it("with reduced motion the cars stand still at the start of their paths and nothing animates", () => {
    renderHomeTrack(svg, TRACK, { reducedMotion: true });
    expect(q("animateMotion")).toHaveLength(0);
    const cars = q<SVGGElement>("g.home-car");
    expect(cars).toHaveLength(3);
    for (const car of cars) expect(car.getAttribute("transform")).toMatch(/^translate\(\d+ \d+\) rotate\(-?[\d.]+\)$/);
    expect(cars[1]!.getAttribute("transform")).toBe("translate(690 494) rotate(180)"); // lane 2, facing along the straight
  });
});

describe("setHomeTrackRunning", () => {
  it("pauses and resumes the laps", () => {
    const pause = vi.fn();
    const unpause = vi.fn();
    Object.assign(svg, { pauseAnimations: pause, unpauseAnimations: unpause });
    setHomeTrackRunning(svg, false);
    setHomeTrackRunning(svg, true);
    expect([pause.mock.calls.length, unpause.mock.calls.length]).toEqual([1, 1]);
  });

  it("is harmless where SMIL control is missing", () => {
    expect(() => setHomeTrackRunning(svg, false)).not.toThrow();
  });
});
