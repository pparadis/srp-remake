import { expect, test } from "@playwright/test";
import { collectErrors, quickRace } from "./support/game";

// ~3 s alone, but 25-30 s when it shares the machine with the long multiplayer journeys (several
// software-rendered Phaser canvases at once), which sat right on the default 30 s limit.
test.setTimeout(90_000);

test("home loads without starting a game, quick race builds the scene, no errors", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/");
  await expect(page.locator("body")).toHaveAttribute("data-screen", "home");
  await expect(page.locator("canvas")).toHaveCount(0);
  expect(await page.evaluate(() => window.__srp === undefined)).toBe(true);

  await quickRace(page, { bots: 2, laps: 1 });
  const cars = await page.evaluate(() => window.__srp!.state().cars.length);
  expect(cars).toBe(3);
  // The game runs on Phaser's Canvas renderer on purpose (AGENTS.md "Race HUD"): a WebGL canvas would return null here.
  expect(await page.evaluate(() => document.querySelector("canvas")!.getContext("2d") !== null)).toBe(true);
  expect(errors).toEqual([]);
});
