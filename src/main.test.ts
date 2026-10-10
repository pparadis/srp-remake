/** @vitest-environment jsdom */
import indexHtml from "../index.html?raw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

// Each test imports a fresh main.ts, which adds its own window listeners: drop them after the test, or a
// back navigation or a key press would also reach the pages of earlier tests.
const added: Array<[string, Parameters<typeof window.removeEventListener>[1]]> = [];
const realAdd = window.addEventListener.bind(window);

// The browser's back button: the URL is already the previous entry when popstate fires.
function goBack(path: string) {
  window.history.replaceState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

async function startSoloRace() {
  byId("homeQuickBtn").click();
  byId("lobbyStartBtn").click();
  await vi.waitFor(() => expect(startGame).toHaveBeenCalled());
  expect(document.body.dataset.screen).toBe("race");
}

describe("main (solo flow)", () => {
  beforeEach(() => {
    vi.resetModules();
    startGame.mockReset();
    window.history.replaceState({}, "", "/");
    window.localStorage.clear();
    loadBody();
    vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
      if (listener) added.push([type, listener]);
      realAdd(type, listener, options);
    });
  });

  afterEach(() => {
    for (const [type, listener] of added.splice(0)) window.removeEventListener(type, listener);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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
        botLevel: "hard",
        seed: expect.any(Number)
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

  it("back from /solo returns home", async () => {
    await import("./main");
    byId("homeQuickBtn").click();
    expect(window.location.pathname).toBe("/solo");
    goBack("/");
    expect(document.body.dataset.screen).toBe("home");
  });

  it("back from a solo race asks before leaving, and stays on the race when declined", async () => {
    const destroy = vi.fn();
    startGame.mockReturnValue({ destroy });
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await import("./main");
    await startSoloRace();

    goBack("/solo");
    expect(confirm).toHaveBeenCalledWith("Leave race?");
    expect(window.location.pathname).toBe("/solo/race");
    expect(document.body.dataset.screen).toBe("race");
    expect(destroy).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    goBack("/solo");
    expect(window.location.pathname).toBe("/solo");
    expect(document.body.dataset.screen).toBe("lobby");
    expect(destroy).toHaveBeenCalled();
  });

  it("leaves a finished race without asking", async () => {
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    startGame.mockReturnValue({ destroy: vi.fn() });
    await import("./main");
    await startSoloRace();
    window.dispatchEvent(new CustomEvent("srp:race-finished", { detail: { winnerCarId: 1 } }));
    expect(byId("results").hidden).toBe(false);
    expect(byId("resultsWinner").textContent).toBe("Car 1 (you) wins");
    goBack("/solo");
    expect(confirm).not.toHaveBeenCalled();
    expect(document.body.dataset.screen).toBe("lobby");
    expect(byId("results").hidden).toBe(true);
  });

  it("the mute toggle follows the button and the M key, and persists across reloads", async () => {
    startGame.mockReturnValue({ destroy: vi.fn() });
    await import("./main");
    expect(tid("hud-mute").textContent).toBe("Sound: on");
    tid("hud-mute").click();
    expect(tid("hud-mute").textContent).toBe("Sound: off");
    expect(window.localStorage.getItem("srp:muted")).toBe("1");

    // reload: a fresh page reads the stored choice
    for (const [type, listener] of added.splice(0)) window.removeEventListener(type, listener);
    vi.resetModules();
    loadBody();
    await import("./main");
    expect(tid("hud-mute").textContent).toBe("Sound: off");

    // M only works on the race screen
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "m" }));
    expect(tid("hud-mute").textContent).toBe("Sound: off");
    await startSoloRace();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "M" }));
    expect(tid("hud-mute").textContent).toBe("Sound: on");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "m", ctrlKey: true }));
    expect(tid("hud-mute").textContent).toBe("Sound: on");
  });

  it("C on the race screen asks the scene to toggle cars and moves", async () => {
    startGame.mockReturnValue({ destroy: vi.fn() });
    const toggles = vi.fn();
    await import("./main");
    window.addEventListener("srp:toggle-cars-moves", toggles);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
    expect(toggles).not.toHaveBeenCalled();
    await startSoloRace();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "c" }));
    expect(toggles).toHaveBeenCalledTimes(1);
  });
});
