import { expect, test, type Browser } from "@playwright/test";
import {
  createLobby,
  expectSameCars,
  guard,
  joinByInvite,
  playMyTurn,
  playOnlineRace,
  playUntilFinished,
  quickRace,
  startRace,
  waitForRace
} from "./support/game";

test.setTimeout(180_000);

async function twoPlayers(browser: Browser) {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  return { host, guest, close: () => Promise.all([host.context().close(), guest.context().close()]) };
}

test("solo: a full 1-lap game against 2 Hard bots, then race again", async ({ page }) => {
  const errors = guard(page);
  await quickRace(page, { bots: 2, laps: 1, botLevel: "hard" });
  // the solo setting reached the scene: both bots are Hard, the player is not a bot
  expect(await page.evaluate(() => window.__srp!.state().cars.map((c) => c.botLevel ?? null))).toEqual([
    null,
    "hard",
    "hard"
  ]);
  await playUntilFinished(page);

  await expect(page.getByTestId("results")).toBeVisible();
  const winner = await page.evaluate(() => window.__srp!.status().winnerCarId);
  expect(winner).not.toBeNull();
  await expect(page.getByTestId("results-winner")).toContainText(`Car ${winner}`);

  await page.getByTestId("results-back-lobby").click();
  await expect(page).toHaveURL(/\/solo$/);
  await expect(page.getByTestId("results")).toBeHidden();
  await expect(page.getByTestId("lobby-bot-level")).toHaveValue("hard"); // the choice is kept

  // start again: a fresh race, nobody has completed a lap
  await page.getByTestId("lobby-start").click();
  await waitForRace(page);
  const laps = await page.evaluate(() => window.__srp!.state().cars.map((c) => c.lapCount));
  expect(laps).toEqual([0, 0, 0]);
  await playMyTurn(page);
  expect(errors).toEqual([]);
});

test("resilience: the guest reloads mid-race and rejoins with the same state", async ({ browser }) => {
  const { host, guest, close } = await twoPlayers(browser);
  const hostErrors = guard(host);
  const guestErrors = guard(guest);

  const invite = await createLobby(host, { name: "Host", bots: 0, laps: 1 });
  await joinByInvite(guest, invite, "Guest");
  await startRace(host);
  await waitForRace(guest);
  await playOnlineRace([host, guest], { stopAfter: 4 });

  await guest.reload();
  await waitForRace(guest);
  await expect(guest).toHaveURL(/\/lobby\/[^/]+\/race$/);
  await expect(guest.locator("body")).toHaveAttribute("data-screen", "race");
  await expectSameCars([host, guest]);

  // the rejoined guest can still play the race to the end
  await playOnlineRace([host, guest]);
  await expect(guest.getByTestId("results-winner")).toHaveText(
    (await host.getByTestId("results-winner").textContent())!
  );
  expect([...hostErrors, ...guestErrors]).toEqual([]);
  await close();
});

// The backend under test gives a host HOST_GRACE_SECONDS=8 (playwright.config.ts) to come back.
test("resilience: when the host closes their page the guest is warned, then told and sent home", async ({ browser }) => {
  const { host, guest, close } = await twoPlayers(browser);
  const guestErrors = guard(guest);

  const invite = await createLobby(host, { name: "Host", bots: 0, laps: 1 });
  await joinByInvite(guest, invite, "Guest");
  await startRace(host);
  await waitForRace(guest);

  await host.close();
  // First the guest is warned that the host is away; the lobby is only closed after the grace period.
  await expect(guest.getByTestId("connection-banner")).toContainText(/host disconnected/i);
  await expect(guest.locator("body")).toHaveAttribute("data-screen", "race");
  await expect(guest.locator("body")).toHaveAttribute("data-screen", "home", { timeout: 20_000 });
  await expect(guest.getByTestId("home-notice")).toContainText(/host disconnected/i);
  await expect(guest).toHaveURL(/\/$/);
  await expect(guest.locator("canvas")).toHaveCount(0);
  expect(guestErrors).toEqual([]);
  await close();
});
