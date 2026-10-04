import { expect, test } from "@playwright/test";
import { collectErrors } from "./support/game";

test("page loads, canvas renders, state exposes cars, no errors", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.locator("canvas")).toBeVisible();
  await page.waitForFunction(() => window.__srp !== undefined);
  const cars = await page.evaluate(() => window.__srp!.state().cars.length);
  expect(cars).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
