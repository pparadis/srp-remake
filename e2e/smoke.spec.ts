import { expect, test } from "@playwright/test";
import { collectErrors, gotoHome, quickRace } from "./support/game";

// ~3 s alone, but 25-30 s when it shares the machine with the long multiplayer journeys (several
// software-rendered Phaser canvases at once), which sat right on the default 30 s limit.
test.setTimeout(90_000);

test("home loads without starting a game, quick race builds the scene, no errors", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?seed=0");
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

test("home shows the web and the server version, and they are the same commit", async ({ page }) => {
  await gotoHome(page);
  const version = page.getByTestId("version");
  await expect(version).toHaveText(/^web [0-9a-f]{7} · \d{4}-\d{2}-\d{2} · server [0-9a-f]{7}$/);
  await expect(version).not.toHaveClass(/is-stale/);
  const [web, server] = (await version.innerText()).match(/\b[0-9a-f]{7}\b/g)!;
  expect(server).toBe(web);
});
