import { expect, test } from "@playwright/test";
import { collectErrors, quickRace } from "./support/game";

test("home loads without starting a game, quick race builds the scene, no errors", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-screen", "home");
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(await page.evaluate(() => window.__srp === undefined)).toBe(true);

  await quickRace(page, { bots: 2, laps: 1 });
  const cars = await page.evaluate(() => window.__srp!.state().cars.length);
  expect(cars).toBe(3);
  expect(errors).toEqual([]);
});
