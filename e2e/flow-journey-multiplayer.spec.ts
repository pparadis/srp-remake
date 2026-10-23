import { expect, test, type Browser } from '@playwright/test';
import {
  createLobby,
  expectSameCars,
  guard,
  joinByInvite,
  playOnlineRace,
  startRace,
  waitForRace
} from './support/game';

// Named flow-* so Playwright's shard split (by test order) puts this long journey in shard 1, away from the
// other long journey (solo-and-rejoin.spec.ts, shard 2).
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

test('multiplayer: host and guest play a 1-lap race, play again, and finish a second race', async ({
  browser
}) => {
  test.setTimeout(300_000); // two full races with two Phaser pages: ~50s alone, ~3 min when workers share the CPU
  const { host, guest, close } = await twoPlayers(browser);
  const hostErrors = guard(host);
  const guestErrors = guard(guest);

  const invite = await createLobby(host, { name: 'Host', bots: 1, laps: 1 });
  await joinByInvite(guest, invite, 'Guest');
  await expect(host.getByTestId('lobby-player')).toHaveCount(2);

  // The guest renames in the lobby (#78): the host's list follows over the socket, and a reload keeps the name.
  await guest.getByTestId('lobby-name').fill('Speedy');
  await guest.getByTestId('lobby-name').press('Enter');
  await expect(host.getByTestId('lobby-players')).toContainText('Speedy');
  await guest.reload();
  await expect(guest.getByTestId('lobby-player').filter({ hasText: 'Speedy (you)' })).toBeVisible();

  // Chat in the lobby: the host's message (with an emoji) reaches the guest over the real socket.
  await host.getByTestId('chat-input').fill('hello 👋');
  await host.getByTestId('chat-send').click();
  await expect(guest.getByTestId('chat-list')).toContainText('hello 👋');
  await expect(host.getByTestId('chat-input')).toHaveValue('');

  await startRace(host);
  await waitForRace(guest);
  await expectSameCars([host, guest]);

  // ...and in the race: the HUD panel is collapsed, counts the guest's message, and shows it once opened.
  await expect(host.getByTestId('hud-chat')).toBeVisible();
  await guest.getByTestId('hud-chat').locator('summary').click();
  await guest.getByTestId('chat-input').fill('gl hf');
  await guest.getByTestId('chat-send').click();
  await expect(host.getByTestId('hud-chat-unread')).toHaveText('(1)');
  await host.getByTestId('hud-chat').locator('summary').click();
  await expect(host.getByTestId('chat-list')).toContainText('gl hf');
  await expect(host.getByTestId('hud-chat-unread')).toBeHidden();

  await playOnlineRace([host, guest]);

  await expect(host.getByTestId('results')).toBeVisible();
  await expect(guest.getByTestId('results')).toBeVisible();
  const hostWinner = await host.getByTestId('results-winner').textContent();
  expect(hostWinner).toMatch(/^Car \d+/);
  await expect(guest.getByTestId('results-winner')).toHaveText(hostWinner!);

  // A guest cannot restart; the host's Play again returns both pages to a fresh lobby.
  await expect(guest.getByTestId('results-play-again')).toBeHidden();
  await expect(guest.getByTestId('results-wait')).toContainText('Waiting for host');
  await host.getByTestId('results-play-again').click();
  for (const page of [host, guest]) {
    await expect(page).toHaveURL(/\/lobby\/[^/]+$/);
    await expect(page.locator('body')).toHaveAttribute('data-screen', 'lobby');
    await expect(page.getByTestId('results')).toBeHidden();
    await expect(page.locator('canvas')).toHaveCount(0);
    await expect(page.getByTestId('lobby-player')).toHaveCount(2);
  }
  await expect(host.getByTestId('lobby-start')).toBeEnabled();

  // Second race on the same lobby: fresh cars, plays to a finish, same winner everywhere.
  await startRace(host);
  await waitForRace(guest);
  const laps = await host.evaluate(() => window.__srp!.state().cars.map((c) => c.lapCount));
  expect(laps.every((lap) => lap === 0)).toBe(true);
  await expectSameCars([host, guest]);
  await playOnlineRace([host, guest]);
  await expect(host.getByTestId('results')).toBeVisible();
  await expect(guest.getByTestId('results')).toBeVisible();
  const secondWinner = await host.getByTestId('results-winner').textContent();
  expect(secondWinner).toMatch(/^Car \d+/);
  await expect(guest.getByTestId('results-winner')).toHaveText(secondWinner!);

  // The recap of the online race (#169): both players get it from the server, the guest opens it and goes back to the
  // lobby, still seated.
  await expect(host.getByTestId('results-recap')).toBeVisible();
  await guest.getByTestId('results-recap').click();
  await expect(guest.getByTestId('recap-car')).toHaveCount(3);
  await guest.getByTestId('recap-car').first().click();
  await expect(guest.getByTestId('recap-move').first()).toBeVisible();
  await guest.getByTestId('recap-back').click();
  await guest.getByTestId('recap-back').click();
  await expect(guest).toHaveURL(/\/lobby\/[^/]+$/);
  await expect(guest.getByTestId('lobby-player')).toHaveCount(2);

  await guest.goto('/');
  expect([...hostErrors, ...guestErrors]).toEqual([]);
  await close();
});
