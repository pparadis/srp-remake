import { expect, test } from "@playwright/test";
import { collectErrors, onCi, playMyTurn, quickRace } from "./support/game";

test.use({ viewport: { width: 1280, height: 800 } });

test("car count matches the lobby settings", async ({ page }) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 3, laps: 1 });
  expect(await page.evaluate(() => window.__srp!.state().cars.length)).toBe(4);
  expect(errors).toEqual([]);
});

test("dragging the active car to a target moves it and advances the turn", async ({ page }) => {
  await quickRace(page, { bots: 2, laps: 1 });
  const before = await page.evaluate(() => {
    const s = window.__srp!.state();
    return { carId: s.activeCarId, cells: s.cars.map((c) => c.cellId) };
  });
  await playMyTurn(page);
  const after = await page.evaluate(() => window.__srp!.state());
  const idx = after.cars.findIndex((c) => c.carId === before.carId);
  expect(after.cars[idx]!.cellId).not.toBe(before.cells[idx]);
  // the turn passed on: the bots moved before control came back
  expect(after.cars.some((c, i) => i !== idx && c.cellId !== before.cells[i])).toBe(true);
});

test("race screen looks like a race track", async ({ page }) => {
  test.skip(!onCi, "pixel baselines are checked on CI only");
  // chromium on a fixed viewport only (see playwright.config.ts); baselines are not shared across OSes
  await quickRace(page, { bots: 0, laps: 1 });
  await page.evaluate(() => window.__srp!.freezeAnimations());
  await expect(page.locator("canvas")).toHaveScreenshot("race-start.png", { animations: "disabled", timeout: 20_000 });
});
