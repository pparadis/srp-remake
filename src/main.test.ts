/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

const startGame = vi.fn();

vi.mock("./game", () => ({
  startGame: (...args: unknown[]) => startGame(...args)
}));

function setupDom() {
  document.body.innerHTML = `
    <div id="app"></div>
    <input id="extraPlayersToggle" type="checkbox" />
    <select id="playerCountSelect">
      <option value="2">2</option>
      <option value="3">3</option>
      <option value="4">4</option>
    </select>
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
    const toggle = document.getElementById("extraPlayersToggle") as HTMLInputElement;
    const select = document.getElementById("playerCountSelect") as HTMLSelectElement;
    const restartBtn = document.getElementById("restartBtn") as HTMLButtonElement;

    expect(startGame).toHaveBeenCalledWith(app, { playerCount: 1 });

    select.disabled = false;
    toggle.checked = false;
    toggle.dispatchEvent(new Event("change"));
    expect(select.disabled).toBe(true);

    toggle.checked = true;
    toggle.dispatchEvent(new Event("change"));
    expect(select.disabled).toBe(false);

    startGame.mockClear();
    select.value = "nope";
    toggle.checked = true;
    restartBtn.dispatchEvent(new MouseEvent("click"));
    expect(destroy).toHaveBeenCalled();
    expect(startGame).toHaveBeenCalledWith(app, { playerCount: 2 });
  });
});
