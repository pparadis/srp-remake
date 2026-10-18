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

// A dragged car turns with the road under the finger, and a refused drop glides it home (#110). Real pointer input on a
// real canvas: the rotation of the body and where the token is read through the hook.
test("a dragged car turns with the road into a bend, and a refused drop sends it back to its cell", async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto("/?seed=0&anim");
  await page.getByTestId("home-quick").click();
  await setLobbySettings(page, { bots: 2, laps: 3 });
  await startRace(page);
  await waitForMyTurn(page);

  const info = await page.evaluate(async () => {
    const srp = window.__srp!;
    const me = srp.state().cars.find((c) => c.carId === 1)!;
    const track = (await (await fetch("/tracks/oval16_3lanes.json")).json()) as {
      cells: { id: string; laneIndex: number; zoneIndex: number; pos: { x: number; y: number }; next: string[] }[];
    };
    const byId = new Map(track.cells.map((c) => [c.id, c]));
    // the road's heading at a cell as the game draws it: previous -> next cell of the lane; sprites point up (+π/2)
    const rotationAt = (id: string) => {
      const cell = byId.get(id)!;
      const next = cell.next.map((n) => byId.get(n)!).find((c) => c.laneIndex === cell.laneIndex)!;
      const prev = track.cells.find((c) => c.laneIndex === cell.laneIndex && c.next.includes(id))!;
      return Math.atan2(next.pos.y - prev.pos.y, next.pos.x - prev.pos.x) + Math.PI / 2;
    };
    // the finger follows the road: the cells of the car's own lane from its zone to the first bend (the heading has
    // turned well away from the straight's there); across the infield there is no road to turn with
    const lane = byId.get(me.cellId)!.laneIndex;
    const bendId = `Z10_L${lane}_00`;
    const walk: { x: number; y: number }[] = [];
    for (let z = byId.get(me.cellId)!.zoneIndex + 1; z <= 10; z += 1) walk.push(srp.cellScreenPos(`Z${String(z).padStart(2, "0")}_L${lane}_00`)!);
    return {
      startCell: me.cellId,
      startRotation: rotationAt(me.cellId),
      bendRotation: rotationAt(bendId),
      from: srp.tokenScreenPos(1)!,
      walk
    };
  });
  const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
  // the bend must differ from the straight, or the check proves nothing
  expect(Math.abs(wrap(info.bendRotation - info.startRotation))).toBeGreaterThan(0.5);

  await page.mouse.move(info.from.x, info.from.y);
  await page.mouse.down();
  for (const p of info.walk) await page.mouse.move(p.x, p.y, { steps: 4 });
  // held over the bend: the body turns to the road there (the e2e build draws at 10 fps, so give the queued moves a moment)
  await expect
    .poll(async () => Math.abs(wrap((await page.evaluate(() => window.__srp!.tokenRotation(1)!)) - info.bendRotation)), {
      message: `the road at the bend points at ${info.bendRotation}`,
      timeout: 4000
    })
    // within 0.5 rad of the road (the start was 90° away): it eases a third of the gap per drag event, so it is not there yet
    .toBeLessThan(0.5);

  // dropped on a cell that is not offered (far across the infield): refused, back on its own cell and its own heading
  await page.mouse.move(info.from.x, info.from.y - 150, { steps: 10 });
  await page.mouse.up();
  await expect
    .poll(async () => page.evaluate(() => window.__srp!.tokenScreenPos(1)!), { timeout: 3000 })
    .toEqual(info.from);
  await expect
    .poll(async () => Math.abs(wrap((await page.evaluate(() => window.__srp!.tokenRotation(1)!)) - info.startRotation)), {
      timeout: 3000
    })
    .toBeLessThan(0.05);
  expect((await page.evaluate(() => window.__srp!.state().cars.find((c) => c.carId === 1)!.cellId))).toBe(info.startCell);
  expect(errors).toEqual([]);
});
