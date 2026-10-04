import { expect, test } from "@playwright/test";
import { createLobby, guard, joinByInvite, nextMover, startRace, waitForRace } from "./support/game";

test.setTimeout(120_000);

// Regression: in an online game the car must stay on the cell it was dropped on while the
// server is still answering, instead of sliding back to its old cell (and taking that
// cell's heading) until the answer arrives.
test("online: a car stays where it was dropped while the server is slow", async ({ browser }) => {
  const host = await (await browser.newContext()).newPage();
  const guest = await (await browser.newContext()).newPage();
  const errors = [...guard(host), ...guard(guest)];
  const invite = await createLobby(host, { name: "Host", bots: 0, laps: 5 });
  await joinByInvite(guest, invite, "Guest");
  await startRace(host);
  await waitForRace(host);
  await waitForRace(guest);

  const mover = await nextMover([host, guest]);
  expect(mover).not.toBeNull();
  const page = mover!;
  await page.route("**/turns", async (route) => {
    await new Promise((r) => setTimeout(r, 2500));
    await route.continue();
  });

  const plan = await page.evaluate(() => {
    const srp = window.__srp!;
    const state = srp.state();
    const car = state.cars.find((c) => c.carId === state.activeCarId)!;
    const target = state.movement.validTargets
      .filter((t) => !t.isPitTrigger)
      .sort((a, b) => b.distance - a.distance)[0]!;
    return {
      carId: car.carId,
      from: srp.cellScreenPos(car.cellId)!,
      to: srp.cellScreenPos(target.cellId)!
    };
  });
  await page.mouse.move(plan.from.x, plan.from.y);
  await page.mouse.down();
  await page.mouse.move(plan.to.x, plan.to.y, { steps: 8 });
  await page.mouse.up();

  // Well after the 280 ms slide, still before the delayed server answer.
  await page.waitForTimeout(900);
  const drawn = await page.evaluate((id) => window.__srp!.tokenScreenPos(id)!, plan.carId);
  expect(Math.hypot(drawn.x - plan.to.x, drawn.y - plan.to.y)).toBeLessThan(6);

  // And once the server has answered, it is still there.
  await page.waitForFunction(() => !window.__srp!.status().canControl, undefined, { timeout: 10_000 });
  await page.waitForTimeout(800);
  const settled = await page.evaluate((id) => window.__srp!.tokenScreenPos(id)!, plan.carId);
  expect(Math.hypot(settled.x - plan.to.x, settled.y - plan.to.y)).toBeLessThan(6);
  expect(errors).toEqual([]);
});
