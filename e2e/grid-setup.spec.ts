import { expect, test, type Page } from '@playwright/test';
import { collectErrors, playMyTurn, quickRace } from './support/game';

test.use({ viewport: { width: 1280, height: 800 } });

// Needs a real browser: the Setup button is a canvas object, pressed with the real mouse; the menu it opens is DOM
// (#159), so it is clicked by test id.
type SetupButton = 'wing-minus' | 'fuel-minus' | 'compound-soft' | 'suggest' | 'confirm';

async function pressSetup(page: Page) {
  const pos = await page.evaluate(() => window.__srp!.uiButtonPos('setup'));
  expect(pos, 'the Setup button is on screen').not.toBeNull();
  await page.mouse.click(pos!.x, pos!.y);
}

test('grid setup: Low wing from the Setup button changes the HUD and the budget, and is gone after the first move', async ({
  page
}) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 2, laps: 3 });
  const hudWing = page.getByTestId('hud-wing');
  const budget = page.getByTestId('hud-budget');
  await expect(hudWing).toHaveText('MED');
  await expect(budget).toHaveText('40 / 40');

  const press = async (name: 'setup' | SetupButton) => {
    if (name === 'setup') await pressSetup(page);
    else await page.getByTestId(`setup-${name}`).click();
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
  const press = async (name: 'setup' | SetupButton) => {
    if (name === 'setup') await pressSetup(page);
    else await page.getByTestId(`setup-${name}`).click();
  };
  const panel = page.getByTestId('setup-panel');
  const hudCompound = page.getByTestId('hud-compound');
  const budget = page.getByTestId('hud-budget');

  // dealt medium tires and 95% fuel, which is heavy: 39 - 1
  await expect(hudCompound).toHaveText('MED');
  await expect(page.getByTestId('hud-fuel')).toHaveText('Fuel 95%');
  await expect(budget).toHaveText('38 / 38');
  await expect(page.getByTestId('hud-pace')).toContainText('HEAVY');
  // nobody pressed Setup: the panel is already open
  await expect(panel).toBeVisible();
  // v3 ignores the tire pressures (#163): no row for them (visibility is computed from the CSS, `hidden` alone is not enough)
  await expect(page.getByTestId('setup-psi-row')).toBeHidden();

  await press('compound-soft');
  await press('fuel-minus');
  await press('fuel-minus'); // 95 -> 85, still heavy
  await press('confirm');

  await expect(hudCompound).toHaveText('SOFT');
  await expect(page.getByTestId('hud-fuel')).toHaveText('Fuel 85%');
  await expect(budget).toHaveText('41 / 41'); // soft 42, heavy -1
  // closed, and it does not come back by itself; the Setup button still opens it
  await expect(panel).toBeHidden();
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
  await expect(panel).toBeHidden();

  await playMyTurn(page);
  await expect.poll(() => page.evaluate(() => window.__srp!.uiButtonPos('setup'))).toBeNull();
  expect(errors).toEqual([]);
});

// The reason the menu is DOM (#159): on a phone in landscape it used to sit under the HUD's top bar and under the turn
// banner. Now it is the topmost thing, inside the screen, and its last button is reachable.
test('grid setup on a phone in landscape: the menu is inside the screen and nothing draws over it', async ({
  page
}) => {
  await page.setViewportSize({ width: 874, height: 348 });
  const errors = collectErrors(page);
  await quickRace(page, { bots: 2, laps: 3, rules: 'v3' });
  const card = page.locator('.setup-card');
  await expect(card).toBeVisible();
  const box = (await card.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(874);
  // two columns on a wide screen: it fits the 348 px height without scrolling
  expect(box.height).toBeLessThanOrEqual(348);
  for (const id of ['setup-compound-soft', 'setup-confirm']) {
    const button = page.getByTestId(id);
    await button.scrollIntoViewIfNeeded();
    const b = (await button.boundingBox())!;
    const topmost = await page.evaluate(
      ([x, y]) => document.elementFromPoint(x!, y!)?.getAttribute('data-testid'),
      [b.x + b.width / 2, b.y + b.height / 2]
    );
    expect(topmost, `${id} is the topmost element at its centre`).toBe(id);
  }
  await page.getByTestId('setup-confirm').click();
  await expect(page.getByTestId('setup-panel')).toBeHidden();
  expect(errors).toEqual([]);
});
