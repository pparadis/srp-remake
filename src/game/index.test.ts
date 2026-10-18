import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REG_BOT_CARS, REG_HUMAN_CARS, REG_RACE_LAPS, REG_TOTAL_CARS } from './constants';

const gameCtor = vi.fn();
const observe = vi.fn();
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe = observe;
    disconnect = vi.fn();
  }
);

vi.mock('phaser', () => {
  class MockGame {
    constructor(config: unknown) {
      return gameCtor(config);
    }
  }
  return {
    default: {
      CANVAS: 'CANVAS',
      Core: { Events: { DESTROY: 'destroy' } },
      Scale: {
        RESIZE: 'RESIZE',
        CENTER_BOTH: 'CENTER_BOTH',
        NONE: 'NONE'
      },
      Game: MockGame
    }
  };
});

vi.mock('./scenes/BootScene', () => ({
  BootScene: class BootSceneMock {}
}));

vi.mock('./scenes/RaceScene', () => ({
  RaceScene: class RaceSceneMock {}
}));

function mockGameInstance() {
  return {
    registry: {
      set: vi.fn()
    },
    scale: { gameSize: { width: 0, height: 0 }, getParentBounds: vi.fn(), refresh: vi.fn() },
    events: { once: vi.fn() },
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

describe('startGame', () => {
  beforeEach(() => {
    vi.resetModules();
    gameCtor.mockReset();
    Object.defineProperty(window, 'devicePixelRatio', {
      configurable: true,
      value: 2
    });
  });

  it('builds Phaser config and writes explicit composition to registry', async () => {
    const game = mockGameInstance();
    gameCtor.mockReturnValue(game);
    const { startGame } = await import('./index');
    const parent = document.createElement('div');

    const result = startGame(parent, { totalCars: 6, humanCars: 2, botCars: 4, raceLaps: 20 });

    expect(result).toBe(game);
    expect(gameCtor).toHaveBeenCalledTimes(1);
    const [config] = gameCtor.mock.calls[0] ?? [];
    expect(config).toMatchObject({
      type: 'CANVAS',
      parent,
      width: 1600,
      height: 900,
      // the grass is the container's CSS background: a transparent canvas, no big texture drawn per frame (#79)
      transparent: true,
      // a 2x screen, but sharp rendering is opt-in (?hidpi): Phaser follows the container at 1x
      scale: { mode: 'RESIZE', autoCenter: 'CENTER_BOTH' }
    });
    expectRegistryComposition(game.registry.set, {
      totalCars: 6,
      humanCars: 2,
      botCars: 4,
      raceLaps: 20
    });
    // keeps Phaser's canvas bounds fresh for pointer events (issue #41) and its size in sync with the container
    // (phone rotation), each until the game is destroyed
    expect(observe).toHaveBeenCalledWith(parent);
    expect(game.events.once).toHaveBeenCalledTimes(2);
    expect(game.events.once).toHaveBeenCalledWith('destroy', expect.any(Function));
  });

  it("?hidpi: a 2x screen gets a canvas with twice the container's pixels, shown at 1/2", async () => {
    gameCtor.mockReturnValue(mockGameInstance());
    const { startGame } = await import('./index');
    const parent = document.createElement('div');
    parent.getBoundingClientRect = () => new DOMRect(0, 0, 874, 402);

    startGame(parent, { totalCars: 4, humanCars: 1, botCars: 3, raceLaps: 5, hidpi: true });

    const [config] = gameCtor.mock.calls[0] ?? [];
    expect(config).toMatchObject({ width: 1748, height: 804, scale: { mode: 'NONE', zoom: 0.5 } });
  });
});
