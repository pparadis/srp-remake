import { expect, test } from '@playwright/test';
import { collectErrors, playMyTurn, quickRace } from './support/game';

test.use({ viewport: { width: 1280, height: 800 } });

// Needs a real browser: the Setup button and the modal's buttons are canvas objects, pressed with the real mouse.
test('grid setup: Low wing from the Setup button changes the HUD and the budget, and is gone after the first move', async ({
  page
}) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 2, laps: 3 });
  const hudWing = page.getByTestId('hud-wing');
  const budget = page.getByTestId('hud-budget');
  await expect(hudWing).toHaveText('MED');
  await expect(budget).toHaveText('40 / 40');

  const press = async (name: 'setup' | 'wing-minus' | 'confirm') => {
    const pos = await page.evaluate((n) => window.__srp!.uiButtonPos(n), name);
    expect(pos, `${name} is on screen`).not.toBeNull();
    await page.mouse.click(pos!.x, pos!.y);
  };

  await press('setup');
  await press('wing-minus'); // Medium -> Low
  await press('confirm');

  await expect(hudWing).toHaveText('LOW');
  await expect(budget).toHaveText('41 / 41'); // Low wing +1 (the hard compound adds nothing)
  // it is not a turn: the same car is still on the grid, and may set up again
  expect(await page.evaluate(() => window.__srp!.uiButtonPos('setup'))).not.toBeNull();

  await playMyTurn(page);
  // after the first move the setup is closed
  await expect.poll(() => page.evaluate(() => window.__srp!.uiButtonPos('setup'))).toBeNull();
  expect(errors).toEqual([]);
});
