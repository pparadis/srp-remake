import { expect, test } from '@playwright/test';
import { pixelBaselines, quickRace } from './support/game';

// Pixels and layout only: what the HUD shows is checked without a browser, from a real race
// (src/game/race/race_session.test.ts, src/ui/hud_session.test.ts).

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const tid = (page: import('@playwright/test').Page, id: string) => page.getByTestId(id);

test("the game draws no large texture per frame: the grass is the page's CSS background (#79)", async ({
  page
}) => {
  // Firefox on a real display fell to 9 fps with a 4000x3000 tileSprite redrawn every frame; Chromium and headless
  // Firefox did not show it, so guard the cause instead of the frame rate.
  await page.addInitScript(() => {
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    (window as unknown as { __maxDrawPx: number }).__maxDrawPx = 0;
    CanvasRenderingContext2D.prototype.drawImage = function (
      this: CanvasRenderingContext2D,
      ...args: unknown[]
    ) {
      const source = args[0] as { width?: number; height?: number };
      const px = (source.width ?? 0) * (source.height ?? 0);
      const w = window as unknown as { __maxDrawPx: number };
      if (px > w.__maxDrawPx) w.__maxDrawPx = px;
      return (draw as (...a: unknown[]) => void).apply(this, args);
    } as typeof draw;
  });
  await quickRace(page, { bots: 1, laps: 1 });
  await page.waitForTimeout(500);
  const maxPx = await page.evaluate(
    () => (window as unknown as { __maxDrawPx: number }).__maxDrawPx
  );
  expect(maxPx).toBeGreaterThan(0);
  expect(maxPx, 'largest canvas or image drawn in one drawImage').toBeLessThan(2_000_000);
  expect(
    await page.locator('#app').evaluate((el) => getComputedStyle(el).backgroundImage)
  ).toContain('grass.png');
});

test('race screen with the HUD looks right', async ({ page }) => {
  test.skip(!pixelBaselines, 'the pixel baselines are WebGL and checked on CI only');
  // chromium on a fixed viewport only; baselines are not shared across OSes
  await quickRace(page, { bots: 0, laps: 1 });
  await page.evaluate(() => window.__srp!.freezeAnimations());
  await page.mouse.move(640, 790);
  await expect(page.getByTestId('race-canvas').locator('..')).toHaveScreenshot('race-hud.png', {
    animations: 'disabled',
    // the version line names the commit, so it differs on every build
    style: '[data-testid="version"] { visibility: hidden; }',
    timeout: 20_000
  });
});

for (const size of [
  { width: 1280, height: 800 },
  { width: 1024, height: 700 }
]) {
  test(`HUD stays clear of the track with 11 cars at ${size.width}x${size.height}`, async ({
    page
  }) => {
    await page.setViewportSize(size);
    await quickRace(page, { bots: 10, laps: 1 });
    await expect(page.getByTestId('hud-feed')).toHaveAttribute('open', ''); // the feed starts open = largest HUD
    await expect(tid(page, 'hud-standing-row')).toHaveCount(11);
    await expect(tid(page, 'status-line')).toBeHidden();

    const track = await page.evaluate(async () => {
      const data = await (await fetch('/tracks/oval16_3lanes.json')).json();
      const pts = (data.cells as { id: string }[]).map((c) => window.__srp!.cellScreenPos(c.id)!);
      const xs = pts.map((p) => p.x);
      const ys = pts.map((p) => p.y);
      return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) };
    });
    for (const id of ['hud-card', 'hud-standings', 'hud-feed']) {
      const box = (await tid(page, id).boundingBox())!;
      const apart =
        box.x + box.width <= track.l ||
        box.x >= track.r ||
        box.y + box.height <= track.t ||
        box.y >= track.b;
      expect(apart, `${id} ${JSON.stringify(box)} vs track ${JSON.stringify(track)}`).toBe(true);
    }
  });
}
