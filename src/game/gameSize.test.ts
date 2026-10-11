import { afterEach, describe, expect, it, vi } from "vitest";
import { keepGameSizeInSync, type SizedGame } from "./gameSize";

// A ResizeObserver the test fires by hand.
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed: Element[] = [];
  disconnected = false;
  callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.push(el);
  }
  disconnect() {
    this.disconnected = true;
  }
}

function setup(
  container: { width: number; height: number },
  game: { width: number; height: number },
  scale = 1
) {
  const parent = document.createElement("div");
  parent.getBoundingClientRect = () => new DOMRect(0, 0, container.width, container.height);
  const calls: string[] = [];
  const destroy: (() => void)[] = [];
  const sized: SizedGame = {
    scale: {
      gameSize: game,
      getParentBounds: () => {
        calls.push("getParentBounds");
        return true;
      },
      refresh: () => calls.push("refresh"),
      resize: (width, height) => calls.push(`resize ${width}x${height}`)
    },
    events: { once: (_name, fn) => destroy.push(fn) }
  };
  keepGameSizeInSync(sized, parent, scale);
  const observer = FakeResizeObserver.instances.at(-1)!;
  return { parent, calls, observer, destroy: () => destroy.forEach((fn) => fn()), container };
}

describe("keepGameSizeInSync", () => {
  afterEach(() => {
    FakeResizeObserver.instances = [];
    vi.unstubAllGlobals();
  });

  it("watches the container", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { parent, observer } = setup({ width: 844, height: 390 }, { width: 844, height: 390 });
    expect(observer.observed).toEqual([parent]);
  });

  it("reads the container and applies it when the game is still the old size (issue: portrait, then landscape)", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { calls, observer } = setup({ width: 844, height: 390 }, { width: 390, height: 844 });
    observer.callback();
    expect(calls).toEqual(["getParentBounds", "refresh"]);
  });

  it("does nothing when the game already has the container's size, so it cannot loop", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { calls, observer } = setup({ width: 844, height: 390 }, { width: 844, height: 390 });
    observer.callback();
    expect(calls).toEqual([]);
  });

  it("?hidpi: sizes the canvas in pixels of the screen, the container times the render scale", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { calls, observer } = setup({ width: 844, height: 390 }, { width: 844, height: 390 }, 2);
    observer.callback();
    expect(calls).toEqual(["resize 1688x780"]);
  });

  it("?hidpi: does nothing while the container has no size", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { calls, observer } = setup({ width: 0, height: 0 }, { width: 844, height: 390 }, 2);
    observer.callback();
    expect(calls).toEqual([]);
  });

  it("compares the floored size, as Phaser applies it", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { calls, observer } = setup({ width: 843.6, height: 389.4 }, { width: 843, height: 389 });
    observer.callback();
    expect(calls).toEqual([]);
  });

  it("stops watching when the game is destroyed", () => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    const { observer, destroy } = setup({ width: 844, height: 390 }, { width: 390, height: 844 });
    destroy();
    expect(observer.disconnected).toBe(true);
  });
});
