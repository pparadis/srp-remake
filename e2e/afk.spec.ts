import { expect, test, type Browser } from "@playwright/test";
import { createLobby, expectSameCars, guard, joinByInvite, playOnlineRace, startRace, waitForRace } from "./support/game";

// playwright.config.ts starts the backend with HOST_GRACE_SECONDS=8: a host has 8 s to come back.
// The turn timer and the host's skip are checked without a browser: backend/test/afk.contract.test.ts (server)
// and src/main.multiplayer.test.ts (countdown, skip button).
test.setTimeout(180_000);

async function twoPlayers(browser: Browser) {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  return { host, guest, close: () => Promise.all([host.context().close(), guest.context().close()]) };
}

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
