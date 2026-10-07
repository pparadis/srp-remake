import { beforeEach, describe, expect, it, vi } from "vitest";
import { REG_BOT_CARS, REG_HUMAN_CARS, REG_RACE_LAPS, REG_TOTAL_CARS } from "./constants";

const gameCtor = vi.fn();

vi.mock("phaser", () => {
  class MockGame {
    constructor(config: unknown) {
      return gameCtor(config);
    }
  }
  return {
    default: {
      CANVAS: "CANVAS",
      Scale: {
        RESIZE: "RESIZE",
        CENTER_BOTH: "CENTER_BOTH"
      },
      Game: MockGame
    }
  };
});

vi.mock("./scenes/BootScene", () => ({
  BootScene: class BootSceneMock {}
}));

vi.mock("./scenes/RaceScene", () => ({
  RaceScene: class RaceSceneMock {}
}));

function mockGameInstance() {
  return {
    registry: {
      set: vi.fn()
    },
    destroy: vi.fn()
  };
}

function expectRegistryComposition(
  setMock: ReturnType<typeof vi.fn>,
  expected: { totalCars: number; humanCars: number; botCars: number; raceLaps?: number }
) {
  expect(setMock).toHaveBeenCalledWith(REG_TOTAL_CARS, expected.totalCars);
  expect(setMock).toHaveBeenCalledWith(REG_HUMAN_CARS, expected.humanCars);
  expect(setMock).toHaveBeenCalledWith(REG_BOT_CARS, expected.botCars);
  expect(setMock).toHaveBeenCalledWith(REG_RACE_LAPS, expected.raceLaps ?? 5);
}

describe("startGame", () => {
  beforeEach(() => {
    vi.resetModules();
    gameCtor.mockReset();
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2
    });
  });

  it("builds Phaser config and writes explicit composition to registry", async () => {
    const game = mockGameInstance();
    gameCtor.mockReturnValue(game);
    const { startGame } = await import("./index");
    const parent = document.createElement("div");

    const result = startGame(parent, { totalCars: 6, humanCars: 2, botCars: 4, raceLaps: 20 });

    expect(result).toBe(game);
    expect(gameCtor).toHaveBeenCalledTimes(1);
    const [config] = gameCtor.mock.calls[0] ?? [];
    expect(config).toMatchObject({
      type: "CANVAS",
      parent,
      width: 1600,
      height: 900,
      backgroundColor: "#0b0f14",
      scale: { mode: "RESIZE", autoCenter: "CENTER_BOTH" },
      resolution: 2
    });
    expectRegistryComposition(game.registry.set, { totalCars: 6, humanCars: 2, botCars: 4, raceLaps: 20 });
  });
});
