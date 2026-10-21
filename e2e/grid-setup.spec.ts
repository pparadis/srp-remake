import { expect, test } from '@playwright/test';
import type { PitModalButton } from '../src/game/scenes/ui/pit_modal';
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

// Rules v3 (#148): the panel opens by itself on the first turn, with the three compounds and a fuel load.
test('rules v3: the grid setup opens by itself, picks a compound and a fuel load, and is not forced again', async ({
  page
}) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 2, laps: 3, rules: 'v3' });
  const press = async (name: 'setup' | PitModalButton) => {
    const pos = await page.evaluate((n) => window.__srp!.uiButtonPos(n), name);
    expect(pos, `${name} is on screen`).not.toBeNull();
    await page.mouse.click(pos!.x, pos!.y);
  };
  const hudCompound = page.getByTestId('hud-compound');
  const budget = page.getByTestId('hud-budget');

  // dealt medium tires and 95% fuel, which is heavy: 39 - 1
  await expect(hudCompound).toHaveText('MED');
  await expect(page.getByTestId('hud-fuel')).toHaveText('Fuel 95%');
  await expect(budget).toHaveText('38 / 38');
  await expect(page.getByTestId('hud-pace')).toContainText('HEAVY');
  // nobody pressed Setup: the panel is already open
  await expect.poll(() => page.evaluate(() => window.__srp!.uiButtonPos('confirm'))).not.toBeNull();

  await press('compound-soft');
  await press('fuel-minus');
  await press('fuel-minus'); // 95 -> 85, still heavy
  await press('confirm');

  await expect(hudCompound).toHaveText('SOFT');
  await expect(page.getByTestId('hud-fuel')).toHaveText('Fuel 85%');
  await expect(budget).toHaveText('41 / 41'); // soft 42, heavy -1
  // closed, and it does not come back by itself; the Setup button still opens it
  expect(await page.evaluate(() => window.__srp!.uiButtonPos('confirm'))).toBeNull();
  await press('setup');
  await press('fuel-minus');
  await press('fuel-minus');
  await press('fuel-minus'); // 85 -> 70: not heavy
  await press('confirm');
  await expect(page.getByTestId('hud-fuel')).toHaveText('Fuel 70%');
  await expect(budget).toHaveText('42 / 42');
  await expect(page.getByTestId('hud-pace')).not.toContainText('HEAVY');

  // Suggested fills the panel with the bots' pick; confirming it is a legal setup
  await press('setup');
  await press('suggest');
  await press('confirm');
  await expect.poll(() => page.evaluate(() => window.__srp!.uiButtonPos('confirm'))).toBeNull();

  await playMyTurn(page);
  await expect.poll(() => page.evaluate(() => window.__srp!.uiButtonPos('setup'))).toBeNull();
  expect(errors).toEqual([]);
});
