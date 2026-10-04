import { expect, test } from "@playwright/test";
import {
  collectErrors,
  createLobby,
  guard,
  joinByInvite,
  nextMover,
  playMyTurn,
  playUntilFinished,
  quickRace,
  startRace,
  waitForRace
} from "./support/game";

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const tid = (page: import("@playwright/test").Page, id: string) => page.getByTestId(id);

test("HUD numbers follow the game state after a move", async ({ page }) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 2, laps: 2 });
  await expect(tid(page, "hud-lap")).toHaveText("Lap 0 / 2");
  await expect(tid(page, "hud-banner")).toHaveText("Your turn - drag your car");
  await expect(tid(page, "hud-pip")).toHaveCount(5);

  await playMyTurn(page);

  const mine = await page.evaluate(() => {
    const c = window.__srp!.state().cars.find((car) => car.carId === 1)!;
    return { lap: c.lapCount, tire: Math.round(c.tire), fuel: Math.round(c.fuel) };
  });
  await expect(tid(page, "hud-lap")).toHaveText(`Lap ${mine.lap} / 2`);
  await expect(tid(page, "hud-tire")).toHaveText(`Tire ${mine.tire}%`);
  await expect(tid(page, "hud-fuel")).toHaveText(`Fuel ${mine.fuel}%`);
  expect(mine.tire).toBeLessThan(100);
  await expect(tid(page, "hud-position")).toHaveText(/^P\d \/ 3$/);
  await expect(tid(page, "hud-standing-row")).toHaveCount(3);
  await expect(tid(page, "hud-compound")).toHaveText(/^(SOFT|HARD)$/);
  expect(errors).toEqual([]);
});

test("hovering a target shows its cost in a tooltip", async ({ page }) => {
  await quickRace(page, { bots: 0, laps: 1 });
  const target = await page.evaluate(() => {
    const t = window.__srp!.state().movement.validTargets.find((v) => !v.isPitTrigger)!;
    return window.__srp!.cellScreenPos(t.cellId)!;
  });
  await expect(tid(page, "hud-tooltip")).toBeHidden();
  await page.mouse.move(target.x, target.y);
  await expect(tid(page, "hud-tooltip")).toHaveText(/^Move \d+ - tire -\d+ - fuel -\d+$/);
  await page.mouse.move(5, 790);
  await expect(tid(page, "hud-tooltip")).toBeHidden();
});

test("the turn banner switches when the other player moves", async ({ browser }) => {
  const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const guest = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  const errors = [...guard(host), ...guard(guest)];
  const invite = await createLobby(host, { name: "Host", bots: 0, laps: 1 });
  await joinByInvite(guest, invite, "Guest");
  await startRace(host);
  await waitForRace(guest);

  const first = (await nextMover([host, guest]))!;
  const other = first === host ? guest : host;
  const firstName = first === host ? "Host" : "Guest";
  const otherName = first === host ? "Guest" : "Host";
  await expect(tid(first, "hud-banner")).toHaveText("Your turn - drag your car");
  await expect(tid(other, "hud-banner")).toHaveText(`Waiting for ${firstName}`);
  await playMyTurn(first);
  await expect(tid(other, "hud-banner")).toHaveText("Your turn - drag your car");
  await expect(tid(first, "hud-banner")).toHaveText(`Waiting for ${otherName}`);
  expect(errors).toEqual([]);
  await host.context().close();
  await guest.context().close();
});

test("results overlay shows the winner and the final standings", async ({ page }) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 2, laps: 1 });
  await playUntilFinished(page);

  await expect(tid(page, "results")).toBeVisible();
  const winner = await page.evaluate(() => window.__srp!.status().winnerCarId);
  await expect(tid(page, "results-winner")).toContainText(`Car ${winner}`);
  await expect(tid(page, "hud-banner")).toContainText("Race finished");
  const rows = tid(page, "results-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.first()).toHaveAttribute("data-car-id", String(winner));
  await expect(rows.first()).toContainText("1/1");
  expect(errors).toEqual([]);
});

test("race screen with the HUD looks right", async ({ page }) => {
  // chromium on a fixed viewport only; baselines are not shared across OSes
  await quickRace(page, { bots: 0, laps: 1 });
  await page.evaluate(() => window.__srp!.freezeAnimations());
  await page.mouse.move(640, 790);
  await expect(page.getByTestId("race-canvas").locator("..")).toHaveScreenshot("race-hud.png", {
    animations: "disabled",
    timeout: 20_000
  });
});

for (const size of [
  { width: 1280, height: 800 },
  { width: 1024, height: 700 }
]) {
  test(`HUD stays clear of the track with 11 cars at ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await quickRace(page, { bots: 10, laps: 1 });
    await page.getByTestId("hud-feed").locator("summary").click(); // open drawer = largest HUD
    await expect(tid(page, "hud-standing-row")).toHaveCount(11);
    await expect(tid(page, "status-line")).toBeHidden();

    const track = await page.evaluate(async () => {
      const data = await (await fetch("/tracks/oval16_3lanes.json")).json();
      const pts = (data.cells as { id: string }[]).map((c) => window.__srp!.cellScreenPos(c.id)!);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) };
    });
    for (const id of ["hud-card", "hud-standings", "hud-feed"]) {
      const box = (await tid(page, id).boundingBox())!;
      const apart =
        box.x + box.width <= track.l || box.x >= track.r || box.y + box.height <= track.t || box.y >= track.b;
      expect(apart, `${id} ${JSON.stringify(box)} vs track ${JSON.stringify(track)}`).toBe(true);
    }
  });
}
