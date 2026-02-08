/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

const startGame = vi.fn();

vi.mock("./game", () => ({
  startGame: (...args: unknown[]) => startGame(...args)
}));

function setupDom() {
  document.body.innerHTML = `
    <div id="app"></div>
    <select id="humanCountSelect">
      <option value="0">0</option>
      <option value="1" selected>1</option>
      <option value="2">2</option>
      <option value="3">3</option>
      <option value="4">4</option>
      <option value="11">11</option>
    </select>
    <select id="botCountSelect">
      <option value="0" selected>0</option>
      <option value="1">1</option>
      <option value="2">2</option>
      <option value="10">10</option>
      <option value="11">11</option>
    </select>
    <input id="lapCountInput" value="5" />
    <button id="restartBtn"></button>
  `;
}

describe("main", () => {
  beforeEach(() => {
    vi.resetModules();
    startGame.mockReset();
    setupDom();
  });

  it("initializes the game and wires restart flow", async () => {
    const destroy = vi.fn();
    startGame.mockReturnValue({ destroy });

    await import("./main");

    const app = document.getElementById("app");
    const humanSelect = document.getElementById("humanCountSelect") as HTMLSelectElement;
    const botSelect = document.getElementById("botCountSelect") as HTMLSelectElement;
    const lapInput = document.getElementById("lapCountInput") as HTMLInputElement;
    const restartBtn = document.getElementById("restartBtn") as HTMLButtonElement;

    await vi.waitFor(() => {
      expect(startGame).toHaveBeenCalledWith(app, { totalCars: 1, humanCars: 1, botCars: 0, raceLaps: 5 });
    });

    startGame.mockClear();
    humanSelect.value = "3";
    botSelect.value = "2";
    lapInput.value = "12";
    restartBtn.dispatchEvent(new MouseEvent("click"));
    await vi.waitFor(() => {
      expect(destroy).toHaveBeenCalled();
      expect(startGame).toHaveBeenCalledWith(app, { totalCars: 5, humanCars: 3, botCars: 2, raceLaps: 12 });
    });

    startGame.mockClear();
    humanSelect.value = "11";
    botSelect.value = "11";
    lapInput.value = "0";
    restartBtn.dispatchEvent(new MouseEvent("click"));
    await vi.waitFor(() => {
      expect(startGame).toHaveBeenCalledWith(app, { totalCars: 11, humanCars: 11, botCars: 0, raceLaps: 1 });
    });
  });
});
