import { devices, expect, test, type Page } from "@playwright/test";
import { collectErrors, playMyTurn, quickRace } from "./support/game";

// A phone: touch, mobile viewport, landscape. Layout and pixels need a real browser (issue #49).
const { defaultBrowserType: _ignored, ...iphone } = devices["iPhone 13 landscape"];
test.use(iphone);

const tid = (page: Page, id: string) => page.getByTestId(id);

/** Bounding box of every cell centre, in page pixels. */
const trackBox = (page: Page) =>
  page.evaluate(async () => {
    const data = await (await fetch("/tracks/oval16_3lanes.json")).json();
    const pts = (data.cells as { id: string }[]).map((c) => window.__srp!.cellScreenPos(c.id)!);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) };
  });

test("phone in landscape: the HUD is a top bar, the track gets the width, standings sit in a drawer", async ({
  page
}) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 3, laps: 1 });
  const viewport = page.viewportSize()!;
  const track = await trackBox(page);
  expect(track.r - track.l, JSON.stringify(track)).toBeGreaterThan(viewport.width * 0.75);

  for (const id of ["hud-card", "hud-banner", "hud-drawer-toggle"]) {
    const box = (await tid(page, id).boundingBox())!;
    const apart =
      box.x + box.width <= track.l || box.x >= track.r || box.y + box.height <= track.t || box.y >= track.b;
    expect(apart, `${id} ${JSON.stringify(box)} vs track ${JSON.stringify(track)}`).toBe(true);
  }
  await expect(tid(page, "hud-rotate")).toBeHidden();

  await expect(tid(page, "hud-standings")).toBeHidden();
  await tid(page, "hud-drawer-toggle").tap();
  await expect(tid(page, "hud-standings")).toBeVisible();
  await expect(tid(page, "hud-standing-row")).toHaveCount(4);
  await tid(page, "hud-drawer-toggle").tap();
  await expect(tid(page, "hud-standings")).toBeHidden();

  const before = await page.evaluate(() => window.__srp!.state().cars.find((c) => c.carId === 1)!.cellId);
  await playMyTurn(page);
  expect(await page.evaluate(() => window.__srp!.state().cars.find((c) => c.carId === 1)!.cellId)).not.toBe(before);
  expect(errors).toEqual([]);
});

test("phone: tap a target, then Move here (Cancel drops the pick)", async ({ page }) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 2, laps: 2 });
  const target = await page.evaluate(() => {
    const s = window.__srp!.state();
    const t = s.movement.validTargets.filter((x) => !x.isPitTrigger).sort((a, b) => b.distance - a.distance)[0]!;
    return { cellId: t.cellId, pos: window.__srp!.cellScreenPos(t.cellId)! };
  });
  const carCell = () => page.evaluate(() => window.__srp!.state().cars.find((c) => c.carId === 1)!.cellId);
  const before = await carCell();

  // a fingertip lands a few pixels off the cell
  await page.touchscreen.tap(target.pos.x + 4, target.pos.y + 3);
  await expect(tid(page, "hud-select")).toBeVisible();
  await expect(tid(page, "hud-select-confirm")).toHaveText("Move here");
  await tid(page, "hud-select-cancel").tap();
  await expect(tid(page, "hud-select")).toBeHidden();
  expect(await carCell()).toBe(before);

  await page.touchscreen.tap(target.pos.x, target.pos.y);
  await tid(page, "hud-select-confirm").tap();
  await expect.poll(carCell).toBe(target.cellId);
  await expect(tid(page, "hud-select")).toBeHidden();
  // the bots played and it is my turn again
  await expect(tid(page, "hud-banner")).toHaveText("Your turn - drag your car");
  expect(errors).toEqual([]);
});

test("phone held upright: the race asks to turn it, and carries on once it is turned", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await quickRace(page, { bots: 1, laps: 1 });
  await expect(tid(page, "hud-rotate")).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(tid(page, "hud-rotate")).toBeHidden();
  await expect(tid(page, "hud-banner")).toHaveText("Your turn - drag your car");
});
