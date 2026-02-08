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
      AUTO: "AUTO",
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
      type: "AUTO",
      parent,
      width: 1600,
      height: 900,
      backgroundColor: "#0b0f14",
      scale: { mode: "RESIZE", autoCenter: "CENTER_BOTH" },
      resolution: 2
    });
    expectRegistryComposition(game.registry.set, { totalCars: 6, humanCars: 2, botCars: 4, raceLaps: 20 });
  });

  it("clamps explicit composition so humans and bots never exceed total", async () => {
    const game = mockGameInstance();
    gameCtor.mockReturnValue(game);
    const { startGame } = await import("./index");
    const parent = document.createElement("div");

    startGame(parent, { totalCars: 5, humanCars: 4, botCars: 9 });

    expectRegistryComposition(game.registry.set, { totalCars: 5, humanCars: 4, botCars: 1 });
  });

  it("supports legacy options for bot mode and bot fill", async () => {
    const parent = document.createElement("div");
    const { startGame } = await import("./index");

    const gameBotMode = mockGameInstance();
    gameCtor.mockReturnValueOnce(gameBotMode);
    startGame(parent, { playerCount: 3, botMode: true });
    expectRegistryComposition(gameBotMode.registry.set, { totalCars: 3, humanCars: 0, botCars: 3 });

    const gameBotFill = mockGameInstance();
    gameCtor.mockReturnValueOnce(gameBotFill);
    startGame(parent, { playerCount: 4, botFill: true });
    expectRegistryComposition(gameBotFill.registry.set, { totalCars: 4, humanCars: 1, botCars: 3 });

    const gameDefault = mockGameInstance();
    gameCtor.mockReturnValueOnce(gameDefault);
    startGame(parent, {});
    expectRegistryComposition(gameDefault.registry.set, { totalCars: 1, humanCars: 1, botCars: 0 });
  });
});
