import { describe, expect, it } from "vitest";
import { gridSlots, normalizeSeed, personalityOf, SEEDED_STYLES, turnOrderOf, unit } from "./botStyle";

describe("personalityOf", () => {
  it("is a pure function of seed and car; seed 0 is the neutral baseline", () => {
    expect(personalityOf(12345, 3)).toEqual(personalityOf(12345, 3));
    for (let car = 1; car <= 8; car += 1) expect(personalityOf(0, car).key).toBe("balanced");
  });

  it("gives the cars of one race different styles (within a block of five), repeating beyond", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const keys = [1, 2, 3, 4, 5].map((car) => personalityOf(seed, car).key);
      expect(new Set(keys).size).toBe(5);
      expect(personalityOf(seed, 6).key).toBeDefined();
    }
  });

  it("is well distributed: every style appears for every car about a fifth of the time", () => {
    const seeds = 2000;
    for (const car of [1, 2, 3, 4, 7]) {
      const counts = new Map<string, number>();
      for (let seed = 1; seed <= seeds; seed += 1) {
        const key = personalityOf(seed, car).key;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      for (const key of SEEDED_STYLES) {
        const share = (counts.get(key) ?? 0) / seeds;
        expect(share).toBeGreaterThan(0.15);
        expect(share).toBeLessThan(0.25);
      }
    }
  });

  it("lets the pit strategist stop earlier or later depending on the seed", () => {
    const offsets = new Set<number>();
    for (let seed = 1; seed <= 300; seed += 1) {
      for (let car = 1; car <= 5; car += 1) {
        const p = personalityOf(seed, car);
        if (p.key === "strategist") offsets.add(Math.sign(p.pitGain));
      }
    }
    expect([...offsets].sort()).toEqual([-1, 1]);
  });
});

describe("grid and play order", () => {
  it("keeps car order at seed 0", () => {
    expect(gridSlots(0, 5)).toEqual([0, 1, 2, 3, 4]);
    expect(turnOrderOf(0, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("is a permutation of the slots, the same for the same seed, different for other seeds", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 100; seed += 1) {
      const slots = gridSlots(seed, 6);
      expect([...slots].sort()).toEqual([0, 1, 2, 3, 4, 5]);
      expect(gridSlots(seed, 6)).toEqual(slots);
      seen.add(slots.join(","));
    }
    expect(seen.size).toBeGreaterThan(30);
  });

  it("is uniform: every car starts on pole about a quarter of the time", () => {
    const poles = [0, 0, 0, 0];
    for (let seed = 1; seed <= 2000; seed += 1) poles[gridSlots(seed, 4).indexOf(0)]! += 1;
    for (const count of poles) expect(count / 2000).toBeGreaterThan(0.2);
  });

  it("plays the pole sitter first", () => {
    for (let seed = 1; seed <= 50; seed += 1) {
      const order = turnOrderOf(seed, 4);
      const slots = gridSlots(seed, 4);
      expect(order.map((carId) => slots[carId - 1])).toEqual([0, 1, 2, 3]);
    }
  });
});

describe("seed helpers", () => {
  it("accepts non-negative integers only", () => {
    expect(normalizeSeed("42")).toBe(42);
    expect(normalizeSeed(7)).toBe(7);
    for (const bad of ["abc", -1, 1.5, "", undefined, 2 ** 40]) expect(normalizeSeed(bad)).toBe(0);
  });

  it("unit() is in [0, 1) and deterministic", () => {
    for (let i = 0; i < 100; i += 1) {
      const u = unit(i, 3);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      expect(unit(i, 3)).toBe(u);
    }
  });
});
