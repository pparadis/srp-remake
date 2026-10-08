import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bannerText,
  formatCountdown,
  formatStint,
  gapLabel,
  mountHud,
  renderHud,
  renderMute,
  renderResults,
  resourceLevel,
  resourceWarning,
  showToast,
  type HudCar,
  type HudSnapshot
} from "./hud";

const car = (carId: number, over: Partial<HudCar> = {}): HudCar => ({
  carId,
  name: `Car ${carId}`,
  color: "#e5484d",
  isBot: false,
  lap: 1,
  finished: false,
  progress: carId,
  fwd: carId,
  tire: 80,
  fuel: 90,
  compound: "soft",
  state: "ACTIVE",
  pitTurns: 0,
  cycle: [3, 0, 0, 0, 0],
  cycleIndex: 1,
  remaining: 37,
  pitServiced: false,
  stint: { laps: 2.14, moves: 17.2 },
  advice: "ok",
  ...over
});

const snap = (over: Partial<HudSnapshot> = {}): HudSnapshot => ({
  raceLaps: 2,
  spineLen: 28,
  finished: false,
  winnerCarId: null,
  myCarId: 2,
  activeCarId: 2,
  canControl: true,
  cars: [car(1, { isBot: true }), car(2, { lap: 2 }), car(3, { isBot: true })],
  hover: null,
  debugText: null,
  log: ["Car 1 to play."],
  ...over
});

const text = (root: Element, id: string) => root.querySelector(`[data-testid="${id}"]`)!.textContent;

describe("hud", () => {
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement("div");
    document.body.replaceChildren(root);
    mountHud(root);
  });

  it("shows my car: lap, position, resources and budget", () => {
    renderHud(root, snap());
    expect(text(root, "hud-lap")).toBe("Lap 2 / 2");
    expect(text(root, "hud-position")).toBe("P2 / 3");
    expect(text(root, "hud-tire")).toBe("Tire 80%");
    expect(text(root, "hud-fuel")).toBe("Fuel 90%");
    expect(text(root, "hud-compound")).toBe("SOFT");
    expect(text(root, "hud-budget")).toBe("37 / 40");
    expect(root.querySelectorAll('[data-testid="hud-pip"]')).toHaveLength(5);
    expect(root.querySelector('[data-testid="hud-state"]')).toHaveProperty("hidden", true);
  });

  it("flags low resources as crit and shows the hard compound and pit state", () => {
    renderHud(root, snap({ cars: [car(2, { fuel: 12, tire: 55, compound: "hard", state: "PITTING", pitTurns: 2 })] }));
    expect(root.querySelector('[data-testid="hud-fuel"]')!.className).toBe("hud-crit");
    expect(root.querySelector('[data-testid="hud-fuel-bar"]')!.className).toBe("hud-crit");
    expect(root.querySelector('[data-testid="hud-tire"]')!.className).toBe("hud-ok");
    expect(text(root, "hud-compound")).toBe("HARD");
    expect(text(root, "hud-state")).toBe("PITTING 2 turns");
    expect(resourceLevel(19.9)).toBe("crit");
    expect(resourceLevel(30)).toBe("warn");
  });

  it("picks the banner for each turn situation", () => {
    expect(bannerText(snap())).toBe("Your turn - drag your car");
    expect(bannerText(snap({ canControl: false }))).toBe("Waiting for the server");
    expect(bannerText(snap({ activeCarId: 3 }))).toBe("Car 3 (bot) is playing");
    const humans = snap({ activeCarId: 4, cars: [car(2), car(4, { name: "Alice" })] });
    expect(bannerText(humans)).toBe("Waiting for Alice");
    expect(bannerText(snap({ finished: true, winnerCarId: 1 }))).toBe("Race finished - Car 1 wins");
    expect(bannerText(snap({ sandbox: "edit" }))).toBe("Sandbox: editing - drag any car, E to play");
    expect(bannerText(snap({ sandbox: "play" }))).toBe("Your turn - drag your car");
    renderHud(root, snap({ activeCarId: 1 }));
    expect(text(root, "hud-banner")).toBe("Car 1 (bot) is playing");
  });

  it("lists standings with me and the active car highlighted", () => {
    renderHud(root, snap({ activeCarId: 3 }));
    const rows = [...root.querySelectorAll('[data-testid="hud-standing-row"]')];
    expect(rows.map((r) => r.getAttribute("data-car-id"))).toEqual(["1", "2", "3"]);
    expect(rows[1]!.classList.contains("is-me")).toBe(true);
    expect(rows[2]!.classList.contains("is-active")).toBe(true);
    expect(rows[0]!.textContent).toContain("1/2");
    expect(gapLabel(car(2, { progress: 4 }), car(1, { progress: 9 }), 28)).toBe("+5");
    expect(gapLabel(car(2, { progress: 4 }), car(1, { progress: 40 }), 28)).toBe("+1L");
    expect(gapLabel(car(2), undefined, 28)).toBe("-");
  });

  it("shows a bot's style next to its name in the standings, and nothing for a car without one", () => {
    renderHud(root, snap({ cars: [car(1, { isBot: true, style: "Racer" }), car(2)] }));
    const rows = [...root.querySelectorAll('[data-testid="hud-standing-row"]')];
    expect(rows[0]!.textContent).toContain("Car 1 · Racer");
    expect(rows[0]!.querySelector(".hud-style")!.textContent).toBe(" · Racer");
    expect(rows[1]!.querySelector(".hud-style")).toBeNull();
    expect(rows[1]!.textContent).not.toContain("·");
  });

  it("shows the lap you are in, a hint behind the line, and Finished at the end", () => {
    // pole car: Lap 1 straight away, no hint
    renderHud(root, snap({ myCarId: 1 }));
    expect(text(root, "hud-lap")).toBe("Lap 1 / 2");
    expect(root.querySelector('[data-testid="hud-lap-hint"]')).toHaveProperty("hidden", true);
    // behind the line: Lap 0 / N and the hint; the standings column says 0/N and the gap stays small
    const behind = car(2, { lap: 0, progress: -2, fwd: 26 });
    renderHud(root, snap({ cars: [car(1, { progress: 0 }), behind], myCarId: 2 }));
    expect(text(root, "hud-lap")).toBe("Lap 0 / 2");
    expect(root.querySelector('[data-testid="hud-lap-hint"]')).toHaveProperty("hidden", false);
    expect(text(root, "hud-lap-hint")).toBe("Cross the start line to begin lap 1");
    const rows = [...root.querySelectorAll('[data-testid="hud-standing-row"]')];
    expect(rows[1]!.textContent).toContain("0/2");
    expect(rows[1]!.textContent).toContain("+2");
    expect(rows[1]!.textContent).not.toContain("L");
    // finished
    renderHud(root, snap({ cars: [car(2, { lap: 2, finished: true })], myCarId: 2 }));
    expect(text(root, "hud-lap")).toBe("Finished");
    expect(root.querySelector('[data-testid="hud-lap-hint"]')).toHaveProperty("hidden", true);
    expect(root.querySelector('[data-testid="hud-standing-row"]')!.textContent).toContain("Fin");
  });

  it("shows tooltip, debug text and feed only when given", () => {
    renderHud(root, snap());
    expect(root.querySelector('[data-testid="hud-tooltip"]')).toHaveProperty("hidden", true);
    expect(root.querySelector('[data-testid="hud-debug"]')).toHaveProperty("hidden", true);
    renderHud(
      root,
      snap({
        hover: { x: 10, y: 20, distance: 4, moveSpend: 5, tireCost: 3, fuelCost: 2, isPit: true, tireBefore: 50, fuelBefore: 60 },
        debugText: "cell: z1"
      })
    );
    expect(text(root, "hud-tooltip")).toBe("Move 5 - PIT stop: tire and fuel refilled");
    expect(text(root, "hud-debug")).toBe("cell: z1");
    expect(root.querySelectorAll('[data-testid="hud-feed-list"] li')).toHaveLength(1);
  });

  it("shows the stint estimate under the bars and hides the chips when nothing is due", () => {
    renderHud(root, snap());
    expect(text(root, "hud-stint")).toBe("≈ 2.1 laps (~17 moves)");
    expect(root.querySelector('[data-testid="hud-advice"]')).toHaveProperty("hidden", true);
    expect(root.querySelector('[data-testid="hud-warning"]')).toHaveProperty("hidden", true);
    expect(formatStint({ laps: 0.04, moves: 0.8 })).toBe("≈ <0.1 laps (~1 moves)");
    expect(formatStint({ laps: 0, moves: 0 })).toBe("Empty: no stint left");
  });

  it("shows the pit chips, and the zero-resource cap when a resource is gone", () => {
    renderHud(root, snap({ cars: [car(2, { advice: "pit-soon" })] }));
    expect(text(root, "hud-advice")).toBe("Pit this lap");
    renderHud(root, snap({ cars: [car(2, { advice: "pit-now", fuel: 0 })] }));
    expect(text(root, "hud-advice")).toBe("Pit now");
    expect(root.querySelector('[data-testid="hud-advice"]')!.className).toContain("is-pit-now");
    expect(text(root, "hud-warning")).toBe("Out of fuel: max 4 moves");
    expect(resourceWarning({ tire: 0, fuel: 0 })).toBe("Out of tire and fuel: max 4 moves");
    expect(resourceWarning({ tire: 1, fuel: 1 })).toBeNull();
  });

  it("tooltip shows tire and fuel before and after, coloured by the level they land on", () => {
    const hover = { x: 1, y: 2, distance: 8, moveSpend: 7, tireCost: 5, fuelCost: 4, isPit: false, tireBefore: 63, fuelBefore: 30 };
    renderHud(root, snap({ hover }));
    expect(text(root, "hud-tooltip")).toBe("Move 7 - tire 63% → 58% - fuel 30% → 26%");
    const spans = root.querySelectorAll('[data-testid="hud-tooltip"] span');
    expect([...spans].map((s) => s.className)).toEqual(["hud-ok", "hud-warn"]);
  });

  it("tooltip warns when the move empties tire or fuel, but not when it already was empty", () => {
    const base = { x: 1, y: 2, distance: 8, moveSpend: 7, tireCost: 5, fuelCost: 4, isPit: false };
    renderHud(root, snap({ hover: { ...base, tireBefore: 4, fuelBefore: 80 } }));
    expect(text(root, "hud-tooltip")).toContain("tire 4% → 0%");
    expect(text(root, "hud-tooltip")).toContain("Empties your tire: max 4 moves next");
    renderHud(root, snap({ hover: { ...base, tireBefore: 0, fuelBefore: 80 } }));
    expect(text(root, "hud-tooltip")).not.toContain("Empties");
  });

  it("tooltip names the lane changes of a route that changes lane 2 or more times", () => {
    const hover = { x: 1, y: 2, distance: 7, moveSpend: 9, tireCost: 5, fuelCost: 4, isPit: false, tireBefore: 63, fuelBefore: 30 };
    renderHud(root, snap({ hover }));
    expect(text(root, "hud-tooltip")).toBe("Move 9 - tire 63% → 58% - fuel 30% → 26%");
    renderHud(root, snap({ hover: { ...hover, laneChanges: 2 } }));
    expect(text(root, "hud-tooltip")).toBe("Move 9 (2 lane changes) - tire 63% → 58% - fuel 30% → 26%");
  });

  it("tooltip and banner describe a squeeze", () => {
    const hover = { x: 1, y: 2, distance: 3, moveSpend: 7, tireCost: 5, fuelCost: 4, isPit: false, squeezePassed: 2, tireBefore: 63, fuelBefore: 30 };
    renderHud(root, snap({ hover, boxedIn: true }));
    expect(text(root, "hud-tooltip")).toBe("Squeeze past 2 cars - Move 7 (+4 points) - tire 63% → 58% - fuel 30% → 26%");
    expect(text(root, "hud-banner")).toBe("Boxed in - squeeze past (+2 points per car)");
    renderHud(root, snap({ hover: { ...hover, squeezePassed: 1, moveSpend: 4 } }));
    expect(text(root, "hud-tooltip")).toContain("Squeeze past 1 car - Move 4 (+2 points)");
    renderHud(root, snap({ boxedIn: true, pitExitBlocked: true }));
    expect(text(root, "hud-banner")).toBe("Pit exit blocked - squeeze out (+2 points per car)");
  });

  it("renders the mute toggle label", () => {
    renderMute(root, true);
    expect(text(root, "hud-mute")).toBe("Sound: off");
    expect(root.querySelector('[data-testid="hud-mute"]')!.getAttribute("aria-pressed")).toBe("true");
    renderMute(root, false);
    expect(text(root, "hud-mute")).toBe("Sound: on");
  });

  describe("toast", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("shows, replaces and hides itself", () => {
      const toast = root.querySelector('[data-testid="hud-toast"]') as HTMLElement;
      expect(toast.hidden).toBe(true);
      showToast(root, "Lap 1 / 3", "lap");
      expect(toast.hidden).toBe(false);
      vi.advanceTimersByTime(2000);
      showToast(root, "Final lap", "final");
      vi.advanceTimersByTime(2000); // the first timer must not hide the second toast
      expect(toast.hidden).toBe(false);
      expect(toast.textContent).toBe("Final lap");
      expect(toast.className).toContain("is-final");
      vi.advanceTimersByTime(600);
      expect(toast.hidden).toBe(true);
    });
  });

  it("renders the final standings into the results table", () => {
    document.body.insertAdjacentHTML("beforeend", '<table data-testid="results-standings"><tbody></tbody></table>');
    renderResults(document.body, snap({ finished: true, winnerCarId: 2 }));
    const rows = document.querySelectorAll('[data-testid="results-row"]');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Car 1");
  });
});

describe("formatCountdown", () => {
  it("formats m:ss and rounds up", () => {
    expect(formatCountdown(120_000)).toBe("2:00");
    expect(formatCountdown(59_001)).toBe("1:00");
    expect(formatCountdown(9_400)).toBe("0:10");
    expect(formatCountdown(1)).toBe("0:01");
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(-5)).toBe("0:00");
  });
});
