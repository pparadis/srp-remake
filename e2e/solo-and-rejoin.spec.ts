import { expect, test, type Browser } from '@playwright/test';
import {
  BACKEND_ORIGIN,
  createLobby,
  expectSameCars,
  gotoHome,
  guard,
  joinByInvite,
  playMyTurn,
  playOnlineRace,
  playUntilFinished,
  quickRace,
  setLobbySettings,
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

// Sharing a solo race (#170): with the setting on, the finished race goes to the real server, which replays it and lists it.
// Needs the page, the CORS call to the backend and its history together.
test('solo: a finished race is shared to the public history only when the setting is on', async ({
  page,
  request
}) => {
  const errors = guard(page);
  const backend = BACKEND_ORIGIN;
  const listed = async () =>
    (
      (await (await request.get(`${backend}/api/v1/races`)).json()) as {
        races: Array<{ source: string }>;
      }
    ).races.length;
  const before = await listed();

  // off by default: nothing is sent
  await quickRace(page, { bots: 2, laps: 1 });
  await playUntilFinished(page);
  await expect(page.getByTestId('results')).toBeVisible();
  await expect(page.getByTestId('results-shared')).toBeHidden();
  expect(await listed()).toBe(before);

  // on: the next race is shared, once
  await gotoHome(page);
  await page.getByTestId('home-quick').click();
  // the setting is inside the Quick race card, not hanging off its side
  const card = (await page.locator('#screen-lobby .card').boundingBox())!;
  const box = (await page.getByTestId('lobby-share').boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(card.x);
  expect(box.x + box.width).toBeLessThanOrEqual(card.x + card.width);
  await page.getByTestId('lobby-share').check();
  await setLobbySettings(page, { bots: 2, laps: 1 });
  await startRace(page);
  await playUntilFinished(page);
  await expect(page.getByTestId('results-shared')).toContainText('Shared in the public history');
  await expect.poll(listed).toBe(before + 1);
  const races = (
    (await (await request.get(`${backend}/api/v1/races?limit=1`)).json()) as {
      races: Array<{ source: string; laps: number }>;
    }
  ).races;
  expect(races[0]).toMatchObject({ source: 'solo', laps: 1 });

  // the public history page lists it; it opens as a recap (fetched from the server), and replays on the board
  await gotoHome(page);
  await page.getByTestId('home-history').click();
  await expect(page).toHaveURL(/\/history$/);
  await expect(page.getByTestId('history-race')).toHaveCount(before + 1);
  await page.getByTestId('history-race').first().click();
  await expect(page).toHaveURL(/\/history\/[^/]+$/);
  await expect(page.getByTestId('recap-car')).toHaveCount(3);
  await page.getByTestId('recap-watch').click();
  await expect(page.getByTestId('replay-bar')).toBeVisible();
  await page.getByTestId('replay-next').click();
  await expect(page.getByTestId('replay-count')).toContainText('1 / ');
  await page.getByTestId('replay-recap').click();
  await page.getByTestId('recap-back').click();
  await expect(page.getByTestId('history-race')).toHaveCount(before + 1);
  expect(errors).toEqual([]);
});

// The board replay of a recap (#169): the real scene watches the saved race, state by state, cars moving forward and back.
test('solo: the recap replays the race on the board, forward and back', async ({ page }) => {
  const errors = guard(page);
  await quickRace(page, { bots: 2, laps: 1 });
  await playUntilFinished(page);
  await page.getByTestId('results-recap').click();
  await page.getByTestId('recap-watch').click();

  await expect(page).toHaveURL(/\/recap\/[^/]+\/board$/);
  await expect(page.getByTestId('replay-bar')).toBeVisible();
  await expect(page.locator('canvas')).toHaveCount(1);
  await expect(page.getByTestId('replay-count')).toContainText('0 / ');
  const cells = () =>
    page.evaluate(() => window.__srp?.state().cars.map((c) => `${c.carId}:${c.cellId}`) ?? []);
  await expect.poll(async () => (await cells()).length).toBe(3);
  const grid = await cells();

  for (let i = 0; i < 3; i += 1) await page.getByTestId('replay-next').click();
  await expect(page.getByTestId('replay-count')).toContainText('3 / ');
  await expect.poll(cells).not.toEqual(grid);
  const afterThree = await cells();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByTestId('replay-count')).toContainText('2 / ');
  await page.keyboard.press('ArrowRight');
  await expect.poll(cells).toEqual(afterThree);
  for (let i = 0; i < 3; i += 1) await page.getByTestId('replay-prev').click();
  await expect.poll(cells).toEqual(grid);

  // the replay reaching the flag is not a race ending: no results screen
  const total = Number(
    /\/ (\d+)/.exec((await page.getByTestId('replay-count').textContent())!)![1]
  );
  for (let i = 0; i < total; i += 1) await page.getByTestId('replay-next').click();
  await expect(page.getByTestId('replay-next')).toBeDisabled();
  await expect(page.getByTestId('results')).toBeHidden();
  await page.getByTestId('replay-recap').click();
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
