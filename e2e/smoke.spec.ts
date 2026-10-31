import { expect, test } from '@playwright/test';
import { collectErrors, gotoHome, onCi, quickRace } from './support/game';

// ~3 s alone, but 25-30 s when it shares the machine with the long multiplayer journeys (several
// software-rendered Phaser canvases at once), which sat right on the default 30 s limit.
test.setTimeout(90_000);

test('home loads without starting a game, quick race builds the scene, no errors', async ({
  page
}) => {
  const errors = collectErrors(page);
  await page.goto('/?seed=0&rules=v3');
  await expect(page.locator('body')).toHaveAttribute('data-screen', 'home');
  await expect(page.locator('canvas')).toHaveCount(0);
  expect(await page.evaluate(() => window.__srp === undefined)).toBe(true);

  await quickRace(page, { bots: 2, laps: 1 });
  const cars = await page.evaluate(() => window.__srp!.state().cars.length);
  expect(cars).toBe(3);
  // The game is WebGL only (#232, #237): getContext returns the context the canvas already has, or null for the
  // other kind, so a Canvas fallback would show up here as a 2D context.
  expect(
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      return [
        canvas.getContext('2d') !== null,
        !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
      ];
    })
  ).toEqual([false, true]);
  expect(errors).toEqual([]);
});

test('home shows the web and the server version, and they are the same commit', async ({
  page
}) => {
  await gotoHome(page);
  const version = page.getByTestId('version');
  await expect(version).toHaveText(/^web [0-9a-f]{7} · \d{4}-\d{2}-\d{2} · server [0-9a-f]{7}$/);
  await expect(version).not.toHaveClass(/is-stale/);
  const [web, server] = (await version.innerText()).match(/\b[0-9a-f]{7}\b/g)!;
  expect(server).toBe(web);
});

test('home page looks welcoming', async ({ page }) => {
  test.skip(!onCi, 'pixel baselines are checked on CI only');
  // reduced motion is the static grid: the SMIL laps would put the cars somewhere else on every run
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 800 });
  // a player with no saved name is given a random one (#78): fix it, or the picture differs on every run
  await page.addInitScript(() => window.localStorage.setItem('srp:name', 'Player'));
  await gotoHome(page);
  await expect(page.getByTestId('home-track')).toBeVisible();
  // The baseline was rendered by another Chromium build than CI's (text and curve edges differ by about 1% of
  // the pixels); a missing track, a broken layout or a lost section moves far more than 2%.
  await expect(page.locator('body')).toHaveScreenshot('home.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.02,
    timeout: 20_000
  });
});
