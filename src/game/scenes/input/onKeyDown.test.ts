import { describe, expect, it, vi } from "vitest";
import type Phaser from "phaser";
import { onKeyDown } from "./onKeyDown";

// A scene whose keyboard just keeps the handlers, so a test can replay what Phaser emits.
function fakeScene() {
  const handlers = new Map<string, (event: KeyboardEvent) => void>();
  const scene = {
    input: {
      keyboard: { on: (name: string, fn: (event: KeyboardEvent) => void) => handlers.set(name, fn) }
    }
  };
  return {
    scene: scene as unknown as Phaser.Scene,
    emit: (name: string, event: KeyboardEvent) => handlers.get(name)?.(event)
  };
}

describe("onKeyDown", () => {
  it("runs once when Phaser replays the same keydown (another key queued before it)", () => {
    const { scene, emit } = fakeScene();
    const handler = vi.fn();
    onKeyDown(scene, "E", handler);
    const press = new KeyboardEvent("keydown", { key: "e" });
    emit("keydown-E", press);
    emit("keydown-E", press); // the keyup re-reads the queue and emits the same event again
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("runs for every new press", () => {
    const { scene, emit } = fakeScene();
    const handler = vi.fn();
    onKeyDown(scene, "E", handler);
    emit("keydown-E", new KeyboardEvent("keydown", { key: "e" }));
    emit("keydown-E", new KeyboardEvent("keydown", { key: "e" }));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does nothing without a keyboard", () => {
    expect(() => onKeyDown({ input: {} } as unknown as Phaser.Scene, "F", vi.fn())).not.toThrow();
  });
});
