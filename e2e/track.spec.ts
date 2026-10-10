import { expect, test } from "@playwright/test";
import { onCi, playMyTurn, quickRace } from "./support/game";

test.use({ viewport: { width: 1280, height: 800 } });

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

test("the mouse finds the token right after the board moves (issue #41)", async ({ page }) => {
  await quickRace(page, { bots: 1, laps: 1 });
  // Move the board, let Phaser's own 500 ms check pick that up, then put it back and point at the token at once:
  // Phaser used to place the pointer with the bounds it had cached, off the board.
  await page.evaluate(() => (document.getElementById("screen-race")!.style.marginTop = "300px"));
  await page.waitForTimeout(1200);
  const token = await page.evaluate(() => {
    document.getElementById("screen-race")!.style.marginTop = "";
    return window.__srp!.tokenScreenPos(1)!;
  });
  await page.mouse.move(token.x, token.y);
  await expect.poll(() => page.evaluate(() => window.__srp!.pointerProbe().topCarId)).toBe(1);
});

test("race screen looks like a race track", async ({ page }) => {
  test.skip(!onCi, "pixel baselines are checked on CI only");
  // chromium on a fixed viewport only (see playwright.config.ts); baselines are not shared across OSes
  await quickRace(page, { bots: 0, laps: 1 });
  await page.evaluate(() => window.__srp!.freezeAnimations());
  await expect(page.locator("canvas")).toHaveScreenshot("race-start.png", { animations: "disabled", timeout: 20_000 });
});
