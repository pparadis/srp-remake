import { expect, test } from "@playwright/test";
import { collectErrors, playMyTurn, setLobbySettings, startRace } from "./support/game";

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const tid = (page: import("@playwright/test").Page, id: string) => page.getByTestId(id);

async function sandboxRace(page: import("@playwright/test").Page) {
  await page.goto("/?sandbox&seed=0");
  await expect(tid(page, "home-quick")).toBeVisible();
  await tid(page, "home-quick").click();
  await setLobbySettings(page, { bots: 2, laps: 3 });
  await startRace(page);
}

const snapshot = (page: import("@playwright/test").Page) => page.evaluate(() => window.__srp!.state());

test("sandbox: drag a bot onto an offered cell, edit the move points, play on from there", async ({ page }) => {
  const errors = collectErrors(page);
  await sandboxRace(page);
  await expect(tid(page, "sandbox-panel")).toBeVisible();
  await expect(tid(page, "hud-banner")).toHaveText("Sandbox: editing - drag any car, E to play");

  // in edit mode the bots wait and the engine still shows what car 1 is offered
  const before = await snapshot(page);
  expect(before.activeCarId).toBe(1);
  const target = before.movement.validTargets.find((t) => !t.isPitTrigger)!;
  const drag = await page.evaluate(
    ({ cellId }) => {
      const srp = window.__srp!;
      return { from: srp.tokenScreenPos(2)!, to: srp.cellScreenPos(cellId)! };
    },
    { cellId: target.cellId }
  );
  await page.mouse.move(drag.from.x, drag.from.y);
  await page.mouse.down();
  await page.mouse.move(drag.to.x, drag.to.y, { steps: 8 });
  await page.mouse.up();

  // car 2 sits on that cell (no rules) and, grabbed, is the car to play; hand the turn back to car 1
  await expect.poll(async () => (await snapshot(page)).cars.find((c) => c.carId === 2)!.cellId).toBe(target.cellId);
  expect((await snapshot(page)).activeCarId).toBe(2);
  await tid(page, "sandbox-car").selectOption("1");
  await expect.poll(async () => (await snapshot(page)).activeCarId).toBe(1);
  // so car 1 is no longer offered that cell
  const after = await snapshot(page);
  expect(after.movement.validTargets.map((t) => t.cellId)).not.toContain(target.cellId);

  // only 3 move points left: no target costs more
  await tid(page, "sandbox-budget").fill("3");
  await tid(page, "sandbox-budget").press("Tab");
  await expect
    .poll(async () => Math.max(...(await snapshot(page)).movement.validTargets.map((t) => t.moveSpend ?? 0)))
    .toBeLessThanOrEqual(3);

  // leave edit mode with the key and move normally from the edited position
  await page.locator("canvas").click({ position: { x: 5, y: 5 } }); // a click on the board takes the focus back from the panel
  await page.keyboard.press("e");
  await expect(tid(page, "hud-banner")).toHaveText("Your turn - drag your car");
  const mover = (await snapshot(page)).cars.find((c) => c.carId === 1)!.cellId;
  await playMyTurn(page);
  expect((await snapshot(page)).cars.find((c) => c.carId === 1)!.cellId).not.toBe(mover);

  await page.keyboard.press("e");
  await expect(tid(page, "hud-banner")).toHaveText("Sandbox: editing - drag any car, E to play");
  expect(errors).toEqual([]);
});

test("sandbox: a Copy debug position loads back, and it is refused when it does not fit", async ({ page }) => {
  await sandboxRace(page);
  const snap = await snapshot(page);
  const moved = { ...snap, cars: snap.cars.map((c) => (c.carId === 2 ? { ...c, cellId: "Z20_L1_00", lapCount: 2 } : c)) };
  await page.getByText("Load position").click();
  await tid(page, "sandbox-load-text").fill(JSON.stringify(moved));
  await tid(page, "sandbox-load").click();
  await expect.poll(async () => (await snapshot(page)).cars.find((c) => c.carId === 2)!.cellId).toBe("Z20_L1_00");
  expect((await snapshot(page)).cars.find((c) => c.carId === 2)!.lapCount).toBe(2);

  await tid(page, "sandbox-load-text").fill(JSON.stringify({ ...snap, cars: snap.cars.slice(1) }));
  await tid(page, "sandbox-load").click();
  await page.getByTestId("hud-feed").locator("summary").click();
  await expect(tid(page, "hud-feed-list")).toContainText("Load refused");
  expect((await snapshot(page)).cars.find((c) => c.carId === 2)!.cellId).toBe("Z20_L1_00");
});

test("no sandbox without ?sandbox", async ({ page }) => {
  await page.goto("/?seed=0");
  await tid(page, "home-quick").click();
  await setLobbySettings(page, { bots: 1, laps: 1 });
  await startRace(page);
  await expect(tid(page, "hud-banner")).toHaveText("Your turn - drag your car");
  await expect(tid(page, "sandbox-panel")).toHaveCount(0);
});
