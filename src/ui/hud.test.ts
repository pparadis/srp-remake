import { beforeEach, describe, expect, it } from "vitest";
import { bannerText, formatCountdown, gapLabel, mountHud, renderHud, renderResults, resourceLevel, type HudCar, type HudSnapshot } from "./hud";

const car = (carId: number, over: Partial<HudCar> = {}): HudCar => ({
  carId,
  name: `Car ${carId}`,
  color: "#e5484d",
  isBot: false,
  lap: 0,
  fwd: carId,
  tire: 80,
  fuel: 90,
  compound: "soft",
  state: "ACTIVE",
  pitTurns: 0,
  cycle: [3, 0, 0, 0, 0],
  cycleIndex: 1,
  remaining: 37,
  ...over
});

const snap = (over: Partial<HudSnapshot> = {}): HudSnapshot => ({
  raceLaps: 2,
  finished: false,
  winnerCarId: null,
  myCarId: 2,
  activeCarId: 2,
  canControl: true,
  cars: [car(1, { isBot: true }), car(2, { lap: 1 }), car(3, { isBot: true })],
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
    expect(text(root, "hud-lap")).toBe("Lap 1 / 2");
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
    renderHud(root, snap({ activeCarId: 1 }));
    expect(text(root, "hud-banner")).toBe("Car 1 (bot) is playing");
  });

  it("lists standings with me and the active car highlighted", () => {
    renderHud(root, snap({ activeCarId: 3 }));
    const rows = [...root.querySelectorAll('[data-testid="hud-standing-row"]')];
    expect(rows.map((r) => r.getAttribute("data-car-id"))).toEqual(["1", "2", "3"]);
    expect(rows[1]!.classList.contains("is-me")).toBe(true);
    expect(rows[2]!.classList.contains("is-active")).toBe(true);
    expect(rows[0]!.textContent).toContain("0/2");
    expect(gapLabel(car(2, { lap: 0, fwd: 9 }), car(1, { lap: 0, fwd: 4 }))).toBe("+5");
    expect(gapLabel(car(2, { lap: 0 }), car(1, { lap: 1 }))).toBe("+1L");
  });

  it("shows tooltip, debug text and feed only when given", () => {
    renderHud(root, snap());
    expect(root.querySelector('[data-testid="hud-tooltip"]')).toHaveProperty("hidden", true);
    expect(root.querySelector('[data-testid="hud-debug"]')).toHaveProperty("hidden", true);
    renderHud(
      root,
      snap({
        hover: { x: 10, y: 20, distance: 4, moveSpend: 5, tireCost: 3, fuelCost: 2, isPit: true },
        debugText: "cell: z1"
      })
    );
    expect(text(root, "hud-tooltip")).toBe("Move 5 - tire -3 - fuel -2 - PIT");
    expect(text(root, "hud-debug")).toBe("cell: z1");
    expect(root.querySelectorAll('[data-testid="hud-feed-list"] li')).toHaveLength(1);
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
