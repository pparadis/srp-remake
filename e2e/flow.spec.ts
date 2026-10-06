import { expect, test, type Browser, type Page } from "@playwright/test";
import {
  collectErrors,
  createLobby,
  gotoHome,
  joinByInvite,
  quickRace,
  setLobbySettings,
  startRace,
  waitForRace
} from "./support/game";

const screen = (page: Page) => page.locator("body");

async function twoPlayers(browser: Browser) {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  return { host, guest, close: () => Promise.all([host.context().close(), guest.context().close()]) };
}

test.describe("routing", () => {
  test("home does not auto-start a game", async ({ page }) => {
    await gotoHome(page);
    await expect(screen(page)).toHaveAttribute("data-screen", "home");
    await expect(page.locator("canvas")).toHaveCount(0);
  });

  test("quick race pushes /solo; back returns home", async ({ page }) => {
    await gotoHome(page);
    await page.getByTestId("home-quick").click();
    await expect(page).toHaveURL(/\/solo$/);
    await expect(screen(page)).toHaveAttribute("data-screen", "lobby");
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);
    await expect(screen(page)).toHaveAttribute("data-screen", "home");
  });

  test("reloading /solo/race falls back to /solo (offline state is not persisted)", async ({ page }) => {
    await quickRace(page, { bots: 1, laps: 1 });
    await expect(page).toHaveURL(/\/solo\/race$/);
    await page.reload();
    await expect(page).toHaveURL(/\/solo$/);
    await expect(page.getByTestId("lobby-start")).toBeVisible();
    await page.goto("/solo/race");
    await expect(page).toHaveURL(/\/solo$/);
  });

  test("back from a solo race asks before leaving", async ({ page }) => {
    await quickRace(page, { bots: 1, laps: 1 });
    const messages: string[] = [];
    page.once("dialog", (d) => {
      messages.push(d.message());
      void d.dismiss();
    });
    await page.goBack();
    await expect.poll(() => messages).toEqual(["Leave race?"]);
    await expect(page).toHaveURL(/\/solo\/race$/);
    await expect(screen(page)).toHaveAttribute("data-screen", "race");

    page.once("dialog", (d) => void d.accept());
    await page.goBack();
    await expect(page).toHaveURL(/\/solo$/);
    await expect(screen(page)).toHaveAttribute("data-screen", "lobby");
    await expect(page.locator("canvas")).toHaveCount(0);
  });

  test("unknown lobby sends you home with a notice", async ({ page }) => {
    await page.goto("/lobby/does-not-exist");
    await expect(screen(page)).toHaveAttribute("data-screen", "home");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByTestId("home-notice")).toContainText("Could not join");
  });

  test("lobby routes: direct link auto-joins, old ?lobby= redirects, back leaves", async ({ browser }) => {
    const { host, guest, close } = await twoPlayers(browser);
    const invite = await createLobby(host, { name: "Host" });
    const lobbyId = invite.split("/").pop()!;

    // old-style invite link
    await guest.goto(`/?lobby=${lobbyId}`);
    await expect(guest).toHaveURL(new RegExp(`/lobby/${lobbyId}$`));
    await expect(guest.getByTestId("lobby-player")).toHaveCount(2);

    // browser back from the host's lobby goes home
    await host.goBack();
    await expect(screen(host)).toHaveAttribute("data-screen", "home");
    await close();
  });
});

test.describe("solo", () => {
  test("Home -> Quick race -> 3 bots, 2 laps -> Start shows the canvas with that setup", async ({ page }) => {
    const errors = collectErrors(page);
    await gotoHome(page);
    await page.getByTestId("home-quick").click();
    // offline lobby: no player list, no invite, no human count
    await expect(page.getByTestId("lobby-players")).toBeHidden();
    await expect(page.getByTestId("lobby-invite-link")).toBeHidden();
    await expect(page.getByTestId("lobby-humans")).toBeHidden();
    await setLobbySettings(page, { bots: 3, laps: 2 });
    await startRace(page);

    await expect(screen(page)).toHaveAttribute("data-screen", "race");
    await expect(page.locator("canvas")).toBeVisible();
    const snapshot = await page.evaluate(() => ({
      cars: window.__srp!.state().cars.map((c) => c.lapCount),
      laps: window.__srp!.status().raceLaps
    }));
    // pole car is already in lap 1; the car in the last grid row is behind the line (lap 0, -1 done)
    await expect(page.getByTestId("hud-lap")).toHaveText("Lap 1 / 2");
    await expect(page.getByTestId("hud-lap-hint")).toBeHidden();
    expect(snapshot).toEqual({ cars: [0, 0, 0, -1], laps: 2 });
    await expect(page.locator('[data-testid="hud-standing-row"][data-car-id="4"]')).toContainText("0/2");
    await expect(page.locator('[data-testid="hud-standing-row"][data-car-id="1"]')).toContainText("1/2");
    expect(errors).toEqual([]);
  });

  test("C toggles cars+moves without errors", async ({ page }) => {
    const errors = collectErrors(page);
    await quickRace(page, { bots: 1, laps: 1 });
    await page.keyboard.press("c");
    await page.keyboard.press("c");
    expect(errors).toEqual([]);
  });
});

test.describe("online", () => {
  test("host and guest meet in the lobby; only the host controls it; both reach the race", async ({
    browser
  }) => {
    test.setTimeout(60_000); // two Phaser pages: slow when all workers share the CPU
    const { host, guest, close } = await twoPlayers(browser);
    await host.context().grantPermissions(["clipboard-read", "clipboard-write"]);

    const invite = await createLobby(host, { name: "Host" });
    expect(invite).toMatch(/\/lobby\/[^/]+$/);
    await expect(host.getByTestId("lobby-start")).toBeEnabled();

    await host.getByTestId("lobby-copy").click();
    await expect.poll(() => host.evaluate(() => navigator.clipboard.readText())).toBe(invite);

    await joinByInvite(guest, invite, "Guest");

    // host sees both players, one host badge
    await expect(host.getByTestId("lobby-player")).toHaveCount(2);
    await expect(host.getByTestId("host-badge")).toHaveCount(1);
    await expect(host.getByTestId("lobby-player").filter({ hasText: "Guest" })).toBeVisible();

    // guest cannot start or edit; host edits are broadcast
    await expect(guest.getByTestId("lobby-start")).toBeHidden();
    await expect(guest.getByTestId("lobby-play-again")).toBeHidden();
    await expect(guest.getByTestId("lobby-laps")).toBeDisabled();
    await setLobbySettings(host, { laps: 3 });
    await expect(guest.getByTestId("lobby-laps")).toHaveValue("3");

    // bot level: shown once there are bots, host-only, and broadcast like the other settings
    await expect(host.getByTestId("lobby-bot-level")).toBeHidden();
    await setLobbySettings(host, { bots: 1 });
    await expect(guest.getByTestId("lobby-bot-level")).toBeVisible();
    await expect(guest.getByTestId("lobby-bot-level")).toBeDisabled();
    await expect(guest.getByTestId("lobby-bot-level")).toHaveValue("normal");
    await setLobbySettings(host, { botLevel: "hard" });
    await expect(guest.getByTestId("lobby-bot-level")).toHaveValue("hard");

    await startRace(host);
    await waitForRace(guest);
    await expect(host).toHaveURL(/\/lobby\/[^/]+\/race$/);
    await expect(guest).toHaveURL(/\/lobby\/[^/]+\/race$/);
    await expect(screen(host)).toHaveAttribute("data-screen", "race");
    await expect(screen(guest)).toHaveAttribute("data-screen", "race");

    // reload on the race URL rejoins the same race
    const before = await guest.evaluate(() => window.__srp!.state().cars.length);
    await guest.reload();
    await waitForRace(guest);
    await expect(guest).toHaveURL(/\/race$/);
    expect(await guest.evaluate(() => window.__srp!.state().cars.length)).toBe(before);
    await close();
  });
});
