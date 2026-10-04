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

test("solo: a full 1-lap game against 2 bots, then race again", async ({ page }) => {
  const errors = guard(page);
  await quickRace(page, { bots: 2, laps: 1 });
  await playUntilFinished(page);

  await expect(page.getByTestId("results")).toBeVisible();
  const winner = await page.evaluate(() => window.__srp!.status().winnerCarId);
  expect(winner).not.toBeNull();
  await expect(page.getByTestId("results-winner")).toContainText(`Car ${winner}`);

  await page.getByTestId("results-back-lobby").click();
  await expect(page).toHaveURL(/\/solo$/);
  await expect(page.getByTestId("results")).toBeHidden();

  // start again: a fresh race, nobody has a lap yet
  await page.getByTestId("lobby-start").click();
  await waitForRace(page);
  const laps = await page.evaluate(() => window.__srp!.state().cars.map((c) => c.lapCount));
  expect(laps).toEqual([0, 0, 0]);
  await playMyTurn(page);
  expect(errors).toEqual([]);
});

test("multiplayer: host and guest play a 1-lap race, play again, and finish a second race", async ({
  browser
}) => {
  test.setTimeout(300_000); // two full races with two Phaser pages: ~50s alone, ~3 min when workers share the CPU
  const { host, guest, close } = await twoPlayers(browser);
  const hostErrors = guard(host);
  const guestErrors = guard(guest);

  const invite = await createLobby(host, { name: "Host", bots: 1, laps: 1 });
  await joinByInvite(guest, invite, "Guest");
  await expect(host.getByTestId("lobby-player")).toHaveCount(2);
  await startRace(host);
  await waitForRace(guest);
  await expectSameCars([host, guest]);

  await playOnlineRace([host, guest]);

  await expect(host.getByTestId("results")).toBeVisible();
  await expect(guest.getByTestId("results")).toBeVisible();
  const hostWinner = await host.getByTestId("results-winner").textContent();
  expect(hostWinner).toMatch(/^Car \d+/);
  await expect(guest.getByTestId("results-winner")).toHaveText(hostWinner!);

  // A guest cannot restart; the host's Play again returns both pages to a fresh lobby.
  await expect(guest.getByTestId("results-play-again")).toBeHidden();
  await expect(guest.getByTestId("results-wait")).toContainText("Waiting for host");
  await host.getByTestId("results-play-again").click();
  for (const page of [host, guest]) {
    await expect(page).toHaveURL(/\/lobby\/[^/]+$/);
    await expect(page.locator("body")).toHaveAttribute("data-screen", "lobby");
    await expect(page.getByTestId("results")).toBeHidden();
    await expect(page.locator("canvas")).toHaveCount(0);
    await expect(page.getByTestId("lobby-player")).toHaveCount(2);
  }
  await expect(host.getByTestId("lobby-start")).toBeEnabled();

  // Second race on the same lobby: fresh cars, plays to a finish, same winner everywhere.
  await startRace(host);
  await waitForRace(guest);
  const laps = await host.evaluate(() => window.__srp!.state().cars.map((c) => c.lapCount));
  expect(laps.every((lap) => lap === 0)).toBe(true);
  await expectSameCars([host, guest]);
  await playOnlineRace([host, guest]);
  await expect(host.getByTestId("results")).toBeVisible();
  await expect(guest.getByTestId("results")).toBeVisible();
  const secondWinner = await host.getByTestId("results-winner").textContent();
  expect(secondWinner).toMatch(/^Car \d+/);
  await expect(guest.getByTestId("results-winner")).toHaveText(secondWinner!);

  await guest.goto("/");
  expect([...hostErrors, ...guestErrors]).toEqual([]);
  await close();
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

test("resilience: when the host closes their page the guest is told and sent home", async ({ browser }) => {
  const { host, guest, close } = await twoPlayers(browser);
  const guestErrors = guard(guest);

  const invite = await createLobby(host, { name: "Host", bots: 0, laps: 1 });
  await joinByInvite(guest, invite, "Guest");
  await startRace(host);
  await waitForRace(guest);

  await host.close();
  await expect(guest.locator("body")).toHaveAttribute("data-screen", "home");
  await expect(guest.getByTestId("home-notice")).toContainText(/host disconnected/i);
  await expect(guest).toHaveURL(/\/$/);
  await expect(guest.locator("canvas")).toHaveCount(0);
  expect(guestErrors).toEqual([]);
  await close();
});
