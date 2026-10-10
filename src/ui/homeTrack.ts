// The animated mini track on the home page: an inline SVG of the real track, three cars lapping it with SMIL
// (`animateMotion`, no JS loop, no canvas) and one of them diving into the pit lane every other lap. Phaser-free.
import track from "../../public/tracks/oval16_3lanes.json";
import { MAIN_LANES, PIT_LANE } from "../game/constants";
import { CAR_SPRITES } from "../game/systems/spawnSystem";
import type { TrackCell, TrackData } from "../game/types/track";

const SVG_NS = "http://www.w3.org/2000/svg";
const PAD = 40; // room for the curbs and the cars
const CAR = { w: 15, h: 28 }; // as drawn in the race
/** Seconds per lap: the outer lane is the longest way round, so it is the slowest. */
const LAP_SECONDS = [9, 10.5, 12.5];

type Point = { x: number; y: number };

function svgEl(name: string, attrs: Record<string, string | number> = {}) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  return el;
}

const byForward = (a: TrackCell, b: TrackCell) => a.forwardIndex - b.forwardIndex;
const points = (cells: TrackCell[]): Point[] => cells.map((c) => c.pos);
const pathData = (pts: Point[], closed: boolean) =>
  `M ${pts.map((p) => `${p.x} ${p.y}`).join(" L ")}${closed ? " Z" : ""}`;

/** The lane's cells in driving order. */
export function laneCells(data: TrackData, laneIndex: number): TrackCell[] {
  return data.cells.filter((c) => c.laneIndex === laneIndex).sort(byForward);
}

/**
 * The lap that stops in the pits, as one closed path: it starts where the pit exit rejoins lane 1, runs lane 1 to the
 * cell that leads into the pit entry, drives the pit lane and ends on the rejoin cell again. Null when the track has no pit.
 */
export function pitLapPoints(data: TrackData): Point[] | null {
  const byId = new Map(data.cells.map((c) => [c.id, c]));
  const entry = data.cells.find((c) => c.tags?.includes("PIT_ENTRY"));
  const exit = data.cells.find((c) => c.tags?.includes("PIT_EXIT"));
  const rejoin = exit?.next.map((id) => byId.get(id)).find((c) => c?.laneIndex === MAIN_LANES[0]);
  const feeder = entry && data.cells.find((c) => c.laneIndex === MAIN_LANES[0] && c.next.includes(entry.id));
  if (!entry || !exit || !rejoin || !feeder) return null;
  const lane = laneCells(data, MAIN_LANES[0]);
  // lane 1 from the rejoin cell round to the feeder (it wraps past the start line)
  const from = lane.indexOf(rejoin);
  const run = [...lane.slice(from), ...lane.slice(0, from)];
  const toFeeder = run.slice(0, run.indexOf(feeder) + 1);
  return [...points(toFeeder), ...points(laneCells(data, PIT_LANE))];
}

/** Which way a car faces at `pts[i]` (degrees, 0 = to the right). */
const headingAt = (pts: Point[], i: number) => {
  const a = pts[i]!;
  const b = pts[(i + 1) % pts.length]!;
  return (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI;
};

function carImage(index: number) {
  // Kenney cars point up; the motion path turns the x axis along the way, so the sprite is turned a quarter.
  return svgEl("image", {
    href: `${import.meta.env.BASE_URL}assets/kenney/${CAR_SPRITES[index % CAR_SPRITES.length]}.png`,
    width: CAR.w,
    height: CAR.h,
    x: -CAR.w / 2,
    y: -CAR.h / 2,
    transform: "rotate(90)"
  });
}

export interface HomeTrackOptions {
  /** Static grid instead of laps (prefers-reduced-motion). */
  reducedMotion?: boolean;
}

export function renderHomeTrack(
  svg: SVGSVGElement,
  data: TrackData = track as unknown as TrackData,
  options: HomeTrackOptions = {}
) {
  const xs = data.cells.map((c) => c.pos.x);
  const ys = data.cells.map((c) => c.pos.y);
  const [minX, maxX, minY, maxY] = [Math.min(...xs) - PAD, Math.max(...xs) + PAD, Math.min(...ys) - PAD, Math.max(...ys) + PAD];
  svg.setAttribute("viewBox", `${minX} ${minY} ${maxX - minX} ${maxY - minY}`);
  svg.replaceChildren();

  const defs = svgEl("defs");
  const lanes = svgEl("g", { class: "home-lanes" });
  const cars = svgEl("g", { class: "home-cars" });
  svg.append(defs, lanes, cars);

  // Lanes: every main lane a closed loop in forwardIndex order, the pit lane an open dashed line.
  for (const lane of MAIN_LANES) {
    const pts = points(laneCells(data, lane));
    if (pts.length === 0) continue;
    const d = pathData(pts, true);
    lanes.append(svgEl("path", { id: `home-lane-${lane}`, class: `home-lane home-lane-${lane}`, d }));
  }
  const pit = points(laneCells(data, PIT_LANE));
  if (pit.length > 0) lanes.append(svgEl("path", { id: "home-pit", class: "home-lane home-lane-pit", d: pathData(pit, false) }));

  // The pit lane joins lane 1 at its entry and its exit: a short dashed link at each end.
  const cellById = new Map(data.cells.map((c) => [c.id, c]));
  for (const from of data.cells) {
    for (const id of from.next) {
      const to = cellById.get(id);
      if (!to || from.laneIndex === to.laneIndex || (from.laneIndex !== PIT_LANE && to.laneIndex !== PIT_LANE)) continue;
      lanes.append(svgEl("path", { class: "home-lane home-lane-pit", d: pathData([from.pos, to.pos], false) }));
    }
  }

  // Start line across every lane (the pit lane too) in the start/finish zone.
  const start = data.cells.find((c) => c.tags?.includes("START_FINISH"));
  if (start) {
    const zone = data.cells.filter((c) => c.zoneIndex === start.zoneIndex);
    const zy = zone.map((c) => c.pos.y);
    const zx = zone.map((c) => c.pos.x);
    lanes.append(
      svgEl("line", {
        class: "home-start",
        x1: Math.min(...zx),
        y1: Math.min(...zy) - 8,
        x2: Math.max(...zx),
        y2: Math.max(...zy) + 8
      })
    );
  }

  // Cars: one per main lane; the first also takes a pit lap every other lap (two laps in one path).
  const pitLap = pitLapPoints(data);
  MAIN_LANES.forEach((lane, i) => {
    const lanePts = points(laneCells(data, lane));
    if (lanePts.length === 0) return;
    const g = svgEl("g", { class: "home-car", "data-lane": lane });
    const seconds = LAP_SECONDS[i % LAP_SECONDS.length]!;
    let pathId = `home-lane-${lane}`;
    let heading = headingAt(lanePts, 0);
    let at = lanePts[0]!;

    if (i === 0 && pitLap) {
      // normal lap from the rejoin cell, then the pit lap, which ends where this one starts
      const startAt = pitLap[0]!;
      const from = lanePts.findIndex((p) => p.x === startAt.x && p.y === startAt.y);
      const around = from < 0 ? lanePts : [...lanePts.slice(from), ...lanePts.slice(0, from)];
      const lap = [...around, ...pitLap];
      defs.append(svgEl("path", { id: "home-pit-lap", d: pathData(lap, true) }));
      pathId = "home-pit-lap";
      heading = headingAt(lap, 0);
      at = lap[0]!;
    }

    if (options.reducedMotion) {
      // static: each car waits at the start of its path, facing along it
      g.setAttribute("transform", `translate(${at.x} ${at.y}) rotate(${heading})`);
    } else {
      const motion = svgEl("animateMotion", {
        dur: `${seconds * (pathId === "home-pit-lap" ? 2 : 1)}s`,
        begin: `${-i * 3.1}s`,
        repeatCount: "indefinite",
        rotate: "auto"
      });
      motion.append(svgEl("mpath", { href: `#${pathId}` }));
      g.append(motion);
    }
    g.append(carImage(i));
    cars.append(g);
  });
}

/** Pauses the laps while the home page is not on screen, so a race or a lobby pays nothing for them. */
export function setHomeTrackRunning(svg: SVGSVGElement, running: boolean) {
  if (running) svg.unpauseAnimations?.();
  else svg.pauseAnimations?.();
}
