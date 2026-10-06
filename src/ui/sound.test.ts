import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSynth, currentlyMuted, isMuted, SOUND_EVENTS, setMuted, shouldPlay } from "./sound";

function fakeContext(state: "running" | "suspended" = "running") {
  const starts: number[] = [];
  const ctx = {
    currentTime: 1,
    state,
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    createOscillator: () => {
      const osc = { type: "", frequency: { value: 0 }, connect: (n: unknown) => n, start: (t: number) => starts.push(t), stop: vi.fn() };
      return osc;
    },
    createGain: () => ({ gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() }, connect: (n: unknown) => n })
  };
  return { ctx: ctx as unknown as AudioContext, starts, resume: ctx.resume };
}

describe("shouldPlay", () => {
  it("plays every known event unless muted", () => {
    for (const event of SOUND_EVENTS) {
      expect(shouldPlay(event, false)).toBe(true);
      expect(shouldPlay(event, true)).toBe(false);
    }
    expect(shouldPlay("nope" as never, false)).toBe(false);
  });
});

describe("mute flag", () => {
  beforeEach(() => window.localStorage.clear());

  it("defaults to unmuted and persists in localStorage", () => {
    expect(isMuted()).toBe(false);
    setMuted(true);
    expect(window.localStorage.getItem("srp:muted")).toBe("1");
    expect(isMuted()).toBe(true);
    setMuted(false);
    expect(isMuted()).toBe(false);
  });

  it("still honours the toggle when storage throws", () => {
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(isMuted()).toBe(false);
    setMuted(true);
    expect(currentlyMuted()).toBe(true);
    get.mockRestore();
    set.mockRestore();
    setMuted(false);
  });
});

describe("synth", () => {
  it("is silent before unlock and while muted, and schedules every note after", () => {
    const { ctx, starts } = fakeContext();
    let muted = true;
    const synth = createSynth(() => ctx, () => muted);
    synth.play("lap");
    synth.unlock();
    synth.play("lap");
    expect(starts).toEqual([]);
    muted = false;
    synth.play("lap");
    expect(starts).toEqual([1, 1.12]);
  });

  it("resumes a suspended context and survives a failing one", () => {
    const { ctx, resume } = fakeContext("suspended");
    createSynth(() => ctx, () => false).unlock();
    expect(resume).toHaveBeenCalled();
    const broken = createSynth(() => {
      throw new Error("no audio");
    });
    expect(() => {
      broken.unlock();
      broken.play("move");
    }).not.toThrow();
  });
});
