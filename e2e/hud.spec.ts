import { expect, test } from "@playwright/test";
import { onCi, quickRace } from "./support/game";

// Pixels and layout only: what the HUD shows is checked without a browser, from a real race
// (src/game/race/raceSession.test.ts, src/ui/hudSession.test.ts).

test.use({ viewport: { width: 1280, height: 800 } });
test.setTimeout(90_000);

const tid = (page: import("@playwright/test").Page, id: string) => page.getByTestId(id);

test("race screen with the HUD looks right", async ({ page }) => {
  test.skip(!onCi, "pixel baselines are checked on CI only");
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
