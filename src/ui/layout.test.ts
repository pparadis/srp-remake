import { afterEach, describe, expect, it, vi } from "vitest";
import { hudGutters, isCompactHud } from "./layout";
import styles from "../style.css?raw";

// A HUD panel at a given page rectangle, docked (or not) through the --hud-dock CSS property.
function panel(hud: HTMLElement, rect: { x: number; y: number; w: number; h: number }, dock?: string) {
  const el = document.createElement("div");
  if (dock) el.style.setProperty("--hud-dock", dock);
  el.getBoundingClientRect = () => new DOMRect(rect.x, rect.y, rect.w, rect.h);
  hud.append(el);
}

const canvas = new DOMRect(0, 0, 1280, 800);

describe("hudGutters", () => {
  it("takes the side columns of a desktop from the left and the right", () => {
    const hud = document.createElement("div");
    panel(hud, { x: 10, y: 10, w: 210, h: 400 }, "left");
    panel(hud, { x: 1020, y: 10, w: 250, h: 300 }, "right");
    panel(hud, { x: 500, y: 10, w: 200, h: 30 }); // the banner floats over the track
    expect(hudGutters(hud, canvas)).toEqual({ left: 230, right: 270, top: 0 });
  });

  it("takes a top bar from the top, and ignores a closed drawer and floating panels", () => {
    const hud = document.createElement("div");
    panel(hud, { x: 6, y: 4, w: 700, h: 30 }, "top");
    panel(hud, { x: 600, y: 40, w: 0, h: 0 }, "right"); // display: none
    panel(hud, { x: 600, y: 40, w: 230, h: 200 }, "none"); // an open drawer covers the track on purpose
    expect(hudGutters(hud, new DOMRect(0, 0, 844, 390), 6)).toEqual({ left: 0, right: 0, top: 40 });
  });

  it("measures from the canvas, not the page", () => {
    const hud = document.createElement("div");
    panel(hud, { x: 30, y: 20, w: 200, h: 100 }, "left");
    expect(hudGutters(hud, new DOMRect(20, 20, 1000, 700)).left).toBe(220);
  });
});

describe("isCompactHud", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("follows the compact media query", () => {
    const matchMedia = vi.fn((query: string) => ({ matches: query === "(max-height: 500px)" }));
    vi.stubGlobal("matchMedia", matchMedia);
    expect(isCompactHud()).toBe(true);
    expect(matchMedia).toHaveBeenCalledWith("(max-height: 500px)");
  });

  it("is false without matchMedia", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(isCompactHud()).toBe(false);
  });
});

describe("page height", () => {
  // On iOS Safari 100vh is the screen with the browser bars hidden; with overflow: hidden on the body the bottom of
  // the race screen is cut off while they show (the first real-phone screenshot). 100dvh is the visible height, and
  // the 100vh line before it is the fallback for browsers that do not know the unit.
  it("sizes the body to the dynamic viewport, with 100vh as the fallback before it", () => {
    const body = /\nbody \{([^}]*background[^}]*)\}/.exec(styles)?.[1] ?? "";
    const heights = [...body.matchAll(/min-height:\s*([^;]+);/g)].map((m) => m[1]);
    expect(heights).toEqual(["100vh", "100dvh"]);
  });
});
