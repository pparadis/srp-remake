import { expect, test, type Browser } from "@playwright/test";
import {
  carCells,
  createLobby,
  expectSameCars,
  guard,
  joinByInvite,
  nextMover,
  playMyTurn,
  playOnlineRace,
  startRace,
  waitForRace
} from "./support/game";

// playwright.config.ts starts the backend with TURN_TIMER_TIME_SCALE=0.1 and HOST_GRACE_SECONDS=8:
// the "2 min" turn timer lasts 12 s here.
test.setTimeout(180_000);

async function twoPlayers(browser: Browser) {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  return { host, guest, close: () => Promise.all([host.context().close(), guest.context().close()]) };
}

const feed = (page: import("@playwright/test").Page) => page.getByTestId("hud-feed-list");

test("afk: nobody plays, the countdown runs out, turns are auto-played and the race goes on", async ({
  browser
}) => {
  const { host, guest, close } = await twoPlayers(browser);
  const hostErrors = guard(host);
  const guestErrors = guard(guest);

  const invite = await createLobby(host, { name: "Host", bots: 0, laps: 1, timer: 120 });
  await joinByInvite(guest, invite, "Guest");
  await expect(host.getByTestId("lobby-turn-timer")).toHaveValue("120");
  await expect(guest.getByTestId("lobby-turn-timer")).toBeDisabled();
  await startRace(host);
  await waitForRace(guest);

  const before = await carCells(host);

  // The countdown is visible to everyone and counts down.
  await expect(guest.getByTestId("hud-timer")).toHaveText(/^Auto-play in 0:\d\d$/);
  await expect(host.getByTestId("hud-timer")).toBeVisible();

  // Both players sit still: the server plays their turns and says so in the feed.
  await expect(feed(guest)).toContainText(/Car \d was auto-played \(timeout\)/, { timeout: 40_000 });
  await expect(feed(host)).toContainText(/auto-played \(timeout\)/);
  await expectSameCars([host, guest]);
  expect(await carCells(host)).not.toBe(before);

  // A human turn still works afterwards and re-arms the timer for the next seat.
  const mover = await nextMover([host, guest]);
  expect(mover).not.toBeNull();
  await playMyTurn(mover!);
  await expectSameCars([host, guest]);
  await expect(host.getByTestId("hud-timer")).toBeVisible();

  expect([...hostErrors, ...guestErrors]).toEqual([]);
  await close();
});

test("afk: the host can skip a stuck guest", async ({ browser }) => {
  const { host, guest, close } = await twoPlayers(browser);
  const hostErrors = guard(host);
  const guestErrors = guard(guest);

  const invite = await createLobby(host, { name: "Host", bots: 0, laps: 1, timer: 120 });
  await joinByInvite(guest, invite, "Guest");
  await startRace(host);
  await waitForRace(guest);

  await playMyTurn(host); // now it is the guest's turn, and the guest does nothing
  await expect(guest.getByTestId("hud-force-skip")).toBeHidden();
  const skip = host.getByTestId("hud-force-skip");
  await expect(skip).toBeVisible();
  await skip.click();

  await expect(feed(host)).toContainText(/auto-played \(host skip\)/);
  await expect(feed(guest)).toContainText(/auto-played \(host skip\)/);
  await expect(skip).toBeHidden(); // the host is on turn again
  await expectSameCars([host, guest]);

  // the host's own turn is theirs to play
  await playMyTurn(host);
  expect([...hostErrors, ...guestErrors]).toEqual([]);
  await close();
});

test("afk: the host reloads mid-race and both pages keep racing", async ({ browser }) => {
  const { host, guest, close } = await twoPlayers(browser);
  const hostErrors = guard(host);
  const guestErrors = guard(guest);

  const invite = await createLobby(host, { name: "Host", bots: 0, laps: 1 });
  await joinByInvite(guest, invite, "Guest");
  await startRace(host);
  await waitForRace(guest);
  await playOnlineRace([host, guest], { stopAfter: 3 });

  await host.reload();
  await waitForRace(host);
  await expect(host).toHaveURL(/\/lobby\/[^/]+\/race$/);
  await expect(guest.locator("body")).toHaveAttribute("data-screen", "race");
  await expect(guest.getByTestId("connection-banner")).toBeHidden();
  await expectSameCars([host, guest]);

  // the race continues for both
  await playOnlineRace([host, guest], { stopAfter: 3 });
  await expect(host.locator("body")).toHaveAttribute("data-screen", "race");
  await expect(guest.locator("body")).toHaveAttribute("data-screen", "race");
  await expect(guest.getByTestId("connection-banner")).toBeHidden();
  expect([...hostErrors, ...guestErrors]).toEqual([]);
  await close();
});
