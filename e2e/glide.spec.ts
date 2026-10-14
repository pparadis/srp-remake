import { expect, test } from "@playwright/test";
import { collectErrors, playMyTurn, setLobbySettings, startRace, waitForMyTurn } from "./support/game";

// The e2e build moves cars at once so the other specs can read where they are; `?anim` turns the glide on. A real
// browser is needed for the Phaser path (Curves, a counter tween, rotation) and for where the token is mid-glide.
test("a bot's car glides to its cell, turning along the lane, one bot after another", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?seed=0&anim");
  await page.getByTestId("home-quick").click();
  await setLobbySettings(page, { bots: 2, laps: 3 });
  await startRace(page);

  // sample every car's token and cell while the player's move and the bots' glides play out
  await page.evaluate(() => {
    const samples: Array<{ t: number; tokens: Record<number, { x: number; y: number }> }> = [];
    (window as unknown as { __samples: typeof samples }).__samples = samples;
    const start = performance.now();
    const tick = () => {
      const srp = window.__srp!;
      const tokens: Record<number, { x: number; y: number }> = {};
      for (const car of srp.state().cars) tokens[car.carId] = srp.tokenScreenPos(car.carId)!;
      samples.push({ t: performance.now() - start, tokens });
      if (samples.length < 400) setTimeout(tick, 20);
    };
    tick();
  });
  const startCells = await page.evaluate(() => Object.fromEntries(window.__srp!.state().cars.map((c) => [c.carId, c.cellId])));
  await playMyTurn(page);
  await page.waitForTimeout(2500);

  // every car left a trail: from where it was to where it is
  const { trails, cells } = await page.evaluate(() => ({
    trails: window.__srp!.overlays().trails,
    cells: Object.fromEntries(window.__srp!.state().cars.map((c) => [c.carId, c.cellId]))
  }));
  expect(trails.map((t) => t.carId).sort(), JSON.stringify(trails)).toEqual([1, 2, 3]);
  for (const trail of trails) {
    expect(trail.cells[0], JSON.stringify(trail)).toBe(startCells[trail.carId]);
    expect(trail.cells.at(-1), JSON.stringify(trail)).toBe(cells[trail.carId]);
    expect(trail.alpha, JSON.stringify(trail)).toBeGreaterThan(0);
  }

  const result = await page.evaluate(() => {
    const srp = window.__srp!;
    const samples = (window as unknown as { __samples: Array<{ t: number; tokens: Record<number, { x: number; y: number }> }> })
      .__samples;
    const cars = srp.state().cars;
    const finalOf = (id: number) => srp.cellScreenPos(cars.find((c) => c.carId === id)!.cellId)!;
    const near = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y) < 1.5;
    // per bot: the first sample at which its token is off its starting position, and at which it has arrived
    const timeline = [2, 3].map((id) => {
      const first = samples[0]!.tokens[id]!;
      const leaves = samples.find((s) => !near(s.tokens[id]!, first));
      const lands = samples.find((s) => near(s.tokens[id]!, finalOf(id)) && !near(s.tokens[id]!, first));
      // a sample strictly between: neither at the start nor on the final cell
      const midway = samples.some((s) => !near(s.tokens[id]!, first) && !near(s.tokens[id]!, finalOf(id)));
      return { id, leavesAt: leaves?.t ?? null, landsAt: lands?.t ?? null, midway };
    });
    return { timeline, final: cars.map((c) => ({ id: c.carId, atCell: near(srp.tokenScreenPos(c.carId)!, finalOf(c.carId)) })) };
  });

  // every bot moved, was seen between its two cells, and ended exactly on its cell
  for (const bot of result.timeline) {
    expect(bot.leavesAt, JSON.stringify(result)).not.toBeNull();
    expect(bot.midway, JSON.stringify(result)).toBe(true);
    expect(bot.landsAt, JSON.stringify(result)).not.toBeNull();
  }
  expect(result.final.every((car) => car.atCell), JSON.stringify(result)).toBe(true);
  // one after another: the second bot does not start before the first has landed
  const [first, second] = result.timeline as [(typeof result.timeline)[number], (typeof result.timeline)[number]];
  expect(second.leavesAt!, JSON.stringify(result)).toBeGreaterThanOrEqual(first.landsAt! - 60);
  expect(errors).toEqual([]);
});

test("the path of the move under the pointer is previewed, and gone when the pointer leaves the targets", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?seed=0&anim");
  await page.getByTestId("home-quick").click();
  await setLobbySettings(page, { bots: 2, laps: 3 });
  await startRace(page);
  await waitForMyTurn(page);

  const plan = await page.evaluate(async () => {
    const srp = window.__srp!;
    const state = srp.state();
    const me = state.cars.find((c) => c.carId === state.activeCarId)!;
    const target = state.movement.validTargets.filter((t) => !t.isPitTrigger).sort((a, b) => b.distance - a.distance)[0]!;
    // the middle of the infield: further than the hover distance from every cell
    const data = await (await fetch("/tracks/oval16_3lanes.json")).json();
    const pts = (data.cells as { id: string }[]).map((c) => srp.cellScreenPos(c.id)!);
    const middle = {
      x: (Math.min(...pts.map((p) => p.x)) + Math.max(...pts.map((p) => p.x))) / 2,
      y: (Math.min(...pts.map((p) => p.y)) + Math.max(...pts.map((p) => p.y))) / 2
    };
    return { from: me.cellId, to: target.cellId, at: srp.cellScreenPos(target.cellId)!, middle };
  });

  expect(await page.evaluate(() => window.__srp!.overlays().preview)).toBeNull();
  await page.mouse.move(plan.at.x, plan.at.y);
  await expect
    .poll(async () => (await page.evaluate(() => window.__srp!.overlays().preview))?.cellId)
    .toBe(plan.to);
  const preview = (await page.evaluate(() => window.__srp!.overlays().preview))!;
  expect(preview.kind).toBe("move");
  expect(preview.cells[0]).toBe(plan.from);
  expect(preview.cells.at(-1)).toBe(plan.to);
  expect(preview.cells.length).toBeGreaterThanOrEqual(2);

  await page.mouse.move(plan.middle.x, plan.middle.y);
  await expect.poll(async () => page.evaluate(() => window.__srp!.overlays().preview)).toBeNull();
  expect(errors).toEqual([]);
});
