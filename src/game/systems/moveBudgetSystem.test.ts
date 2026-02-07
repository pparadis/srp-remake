import { describe, expect, it } from "vitest";
import { computeMoveSpend, createMoveCycle, getRemainingBudget, recordMove } from "./moveBudgetSystem";

describe("moveBudgetSystem", () => {
  it("creates a 5-slot cycle by default", () => {
    const cycle = createMoveCycle();
    expect(cycle.spent).toHaveLength(5);
    expect(cycle.index).toBe(0);
  });

  it("records moves and wraps after 5 turns", () => {
    const cycle = createMoveCycle();
    recordMove(cycle, 3);
    recordMove(cycle, 4);
    recordMove(cycle, 5);
    recordMove(cycle, 6);
    const wrapped = recordMove(cycle, 7);
    expect(wrapped).toBe(true);
    expect(cycle.index).toBe(0);
    expect(cycle.spent).toEqual([0, 0, 0, 0, 0]);
  });

  it("computes remaining budget", () => {
    const cycle = createMoveCycle();
    recordMove(cycle, 8);
    recordMove(cycle, 6);
    expect(getRemainingBudget(cycle)).toBe(26);
  });

  it("counts pit lane movement as 1", () => {
    expect(computeMoveSpend(5, 1, 0)).toBe(1);
    expect(computeMoveSpend(5, 1, 1)).toBe(5);
  });

  it("adds +1 spend when changing between main lanes", () => {
    expect(computeMoveSpend(1, 1, 2, 1)).toBe(2);
    expect(computeMoveSpend(4, 2, 3, 4)).toBe(5);
  });

  it("does not add surcharge when lane change already consumed extra path distance", () => {
    expect(computeMoveSpend(2, 1, 2, 1)).toBe(2);
  });

  it("does not add lane-change surcharge for pit transitions", () => {
    expect(computeMoveSpend(1, 1, 0)).toBe(1);
    expect(computeMoveSpend(1, 0, 1)).toBe(1);
  });
});
