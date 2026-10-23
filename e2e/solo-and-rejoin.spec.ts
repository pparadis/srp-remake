import { expect, test, type Browser } from '@playwright/test';
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
} from './support/game';

test.setTimeout(180_000);

async function twoPlayers(browser: Browser) {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  return {
    host,
    guest,
    close: () => Promise.all([host.context().close(), guest.context().close()])
  };
}

test('solo: a full 1-lap game against 2 Hard bots, then race again', async ({ page }) => {
  const errors = guard(page);
  await quickRace(page, { bots: 2, laps: 1, botLevel: 'hard' });
  // the solo setting reached the scene: both bots are Hard, the player is not a bot
  expect(
    await page.evaluate(() => window.__srp!.state().cars.map((c) => c.botLevel ?? null))
  ).toEqual([null, 'hard', 'hard']);
  await playUntilFinished(page);

  await expect(page.getByTestId('results')).toBeVisible();
  const winner = await page.evaluate(() => window.__srp!.status().winnerCarId);
  expect(winner).not.toBeNull();
  await expect(page.getByTestId('results-winner')).toContainText(`Car ${winner}`);

  await page.getByTestId('results-back-lobby').click();
  await expect(page).toHaveURL(/\/solo$/);
  await expect(page.getByTestId('results')).toBeHidden();
  await expect(page.getByTestId('lobby-bot-level')).toHaveValue('hard'); // the choice is kept

  // start again: a fresh race, nobody has completed a lap
  await page.getByTestId('lobby-start').click();
  await waitForRace(page);
  const laps = await page.evaluate(() => window.__srp!.state().cars.map((c) => c.lapCount));
  expect(laps).toEqual([0, 0, 0]);
  await playMyTurn(page);
  expect(errors).toEqual([]);
});

// The recap of a race just played (#169): the summary, a car's moves, the turn by turn, and the home list (the recap is a
// page of its own, saved in the browser). Needs a real race, real navigation and a reload.
test('solo: the recap of a finished race, from the results and from the home list', async ({
  page
}) => {
  const errors = guard(page);
  await quickRace(page, { bots: 2, laps: 1 });
  await playUntilFinished(page);
  await expect(page.getByTestId('results')).toBeVisible();

  await page.getByTestId('results-recap').click();
  await expect(page).toHaveURL(/\/recap\//);
  await expect(page.getByTestId('recap-car')).toHaveCount(3);
  await page.getByTestId('recap-car').first().click();
  await expect(page.getByTestId('recap-move').first()).toBeVisible();
  await page.getByTestId('recap-car-turns').click();
  await expect(page.getByTestId('recap-turn-detail')).toBeVisible();
  await page.getByTestId('recap-next').click();
  await expect(page.getByTestId('recap-turn-count')).toContainText('2 /');

  // a reload keeps the page (the race is saved), and Back climbs to the home screen, which lists the race
  await page.reload();
  await expect(page.getByTestId('recap-car')).toHaveCount(3);
  await page.getByTestId('recap-back').click();
  await expect(page.getByTestId('home-race')).toHaveCount(1);
  await page.getByTestId('home-race').click();
  await expect(page.getByTestId('recap-car')).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('resilience: the guest reloads mid-race and rejoins with the same state', async ({
  browser
}) => {
  const { host, guest, close } = await twoPlayers(browser);
  const hostErrors = guard(host);
  const guestErrors = guard(guest);

  const invite = await createLobby(host, { name: 'Host', bots: 0, laps: 1 });
  await joinByInvite(guest, invite, 'Guest');
  await startRace(host);
  await waitForRace(guest);
  await playOnlineRace([host, guest], { stopAfter: 4 });

  await guest.reload();
  await waitForRace(guest);
  await expect(guest).toHaveURL(/\/lobby\/[^/]+\/race$/);
  await expect(guest.locator('body')).toHaveAttribute('data-screen', 'race');
  await expectSameCars([host, guest]);

  // the rejoined guest can still play the race to the end
  await playOnlineRace([host, guest]);
  await expect(guest.getByTestId('results-winner')).toHaveText(
    (await host.getByTestId('results-winner').textContent())!
  );
  expect([...hostErrors, ...guestErrors]).toEqual([]);
  await close();
});
