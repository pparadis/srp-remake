/** @vitest-environment jsdom */
import indexHtml from "../index.html?raw";
import { beforeEach, describe, expect, it, vi } from "vitest";

const startGame = vi.fn();

vi.mock("./game", () => ({
  startGame: (...args: unknown[]) => startGame(...args)
}));

// The real page markup, so the test cannot drift from index.html.
function loadBody() {
  
  document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/.exec(indexHtml)![1]!.replace(
    /<script[\s\S]*?<\/script>/g,
    ""
  );
  document.body.dataset.screen = "home";
}

const byId = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

describe("main (solo flow)", () => {
  beforeEach(() => {
    vi.resetModules();
    startGame.mockReset();
    window.history.replaceState({}, "", "/");
    loadBody();
  });

  it("does not start a game on load", async () => {
    await import("./main");
    expect(document.body.dataset.screen).toBe("home");
    expect(startGame).not.toHaveBeenCalled();
  });

  it("quick race -> lobby -> start creates the game with the lobby settings", async () => {
    const destroy = vi.fn();
    startGame.mockReturnValue({ destroy });
    await import("./main");

    byId("homeQuickBtn").click();
    expect(document.body.dataset.screen).toBe("lobby");
    expect(window.location.pathname).toBe("/solo");
    expect(byId("lobbyPlayersBlock").hidden).toBe(true);

    const bots = byId<HTMLSelectElement>("lobbyBots");
    bots.value = "2";
    bots.dispatchEvent(new Event("change"));
    const laps = byId<HTMLInputElement>("lobbyLaps");
    laps.value = "2";
    laps.dispatchEvent(new Event("change"));
    const level = byId<HTMLSelectElement>("lobbyBotLevel");
    expect(level.value).toBe("normal");
    expect(byId("lobbyBotLevelField").hidden).toBe(false);
    level.value = "hard";
    level.dispatchEvent(new Event("change"));

    byId("lobbyStartBtn").click();
    expect(window.location.pathname).toBe("/solo/race");
    await vi.waitFor(() => {
      expect(startGame).toHaveBeenCalledWith(byId("app"), {
        totalCars: 3,
        humanCars: 1,
        botCars: 2,
        raceLaps: 2,
        botLevel: "hard"
      });
    });

    byId("lobbyLeaveBtn").click();
    byId("homeQuickBtn").click();
    expect(destroy).toHaveBeenCalled();
  });

  it("reloading /solo/race falls back to /solo", async () => {
    window.history.replaceState({}, "", "/solo/race");
    await import("./main");
    expect(window.location.pathname).toBe("/solo");
    expect(document.body.dataset.screen).toBe("lobby");
    expect(startGame).not.toHaveBeenCalled();
  });

  it("redirects old ?lobby= links to /lobby/:id", async () => {
    window.history.replaceState({}, "", "/?lobby=abc");
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    await import("./main");
    expect(window.location.pathname).toBe("/lobby/abc");
    expect(window.location.search).toBe("");
    vi.unstubAllGlobals();
  });
});
