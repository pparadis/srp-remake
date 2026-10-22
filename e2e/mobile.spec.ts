import { devices, expect, test, type Page } from '@playwright/test';
import { collectErrors, playMyTurn, quickRace, setLobbySettings, startRace } from './support/game';

// A phone: touch, mobile viewport, landscape. Layout and pixels need a real browser (issue #49).
const { defaultBrowserType: _ignored, ...iphone } = devices['iPhone 13 landscape'];
test.use(iphone);

const tid = (page: Page, id: string) => page.getByTestId(id);

/** Bounding box of every cell centre, in page pixels. */
const trackBox = (page: Page) =>
  page.evaluate(async () => {
    const data = await (await fetch('/tracks/oval16_3lanes.json')).json();
    const pts = (data.cells as { id: string }[]).map((c) => window.__srp!.cellScreenPos(c.id)!);
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { l: Math.min(...xs), r: Math.max(...xs), t: Math.min(...ys), b: Math.max(...ys) };
  });

test('phone in landscape: the HUD is a top bar, the track gets the width, standings sit in a drawer', async ({
  page
}) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 3, laps: 1 });
  const viewport = page.viewportSize()!;
  const track = await trackBox(page);
  expect(track.r - track.l, JSON.stringify(track)).toBeGreaterThan(viewport.width * 0.75);

  for (const id of ['hud-card', 'hud-banner', 'hud-drawer-toggle']) {
    const box = (await tid(page, id).boundingBox())!;
    const apart =
      box.x + box.width <= track.l ||
      box.x >= track.r ||
      box.y + box.height <= track.t ||
      box.y >= track.b;
    expect(apart, `${id} ${JSON.stringify(box)} vs track ${JSON.stringify(track)}`).toBe(true);
  }
  await expect(tid(page, 'hud-rotate')).toBeHidden();

  // The version is not part of the race screen: it sat over the bottom kerb of the board.
  await expect(tid(page, 'version')).toBeHidden();

  await expect(tid(page, 'hud-standings')).toBeHidden();
  await tid(page, 'hud-drawer-toggle').tap();
  await expect(tid(page, 'hud-standings')).toBeVisible();
  await expect(tid(page, 'hud-standing-row')).toHaveCount(4);
  await tid(page, 'hud-drawer-toggle').tap();
  await expect(tid(page, 'hud-standings')).toBeHidden();

  const before = await page.evaluate(
    () => window.__srp!.state().cars.find((c) => c.carId === 1)!.cellId
  );
  await playMyTurn(page);
  expect(
    await page.evaluate(() => window.__srp!.state().cars.find((c) => c.carId === 1)!.cellId)
  ).not.toBe(before);
  expect(errors).toEqual([]);
});

test('phone: tap a target, then Move here (Cancel drops the pick)', async ({ page }) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 2, laps: 2 });
  const target = await page.evaluate(() => {
    const s = window.__srp!.state();
    const t = s.movement.validTargets
      .filter((x) => !x.isPitTrigger)
      .sort((a, b) => b.distance - a.distance)[0]!;
    return { cellId: t.cellId, pos: window.__srp!.cellScreenPos(t.cellId)! };
  });
  const carCell = () =>
    page.evaluate(() => window.__srp!.state().cars.find((c) => c.carId === 1)!.cellId);
  const before = await carCell();

  // a fingertip lands a few pixels off the cell
  await page.touchscreen.tap(target.pos.x + 4, target.pos.y + 3);
  await expect(tid(page, 'hud-select')).toBeVisible();
  await expect(tid(page, 'hud-select-confirm')).toHaveText('Move here');
  await tid(page, 'hud-select-cancel').tap();
  await expect(tid(page, 'hud-select')).toBeHidden();
  expect(await carCell()).toBe(before);

  await page.touchscreen.tap(target.pos.x, target.pos.y);
  await tid(page, 'hud-select-confirm').tap();
  await expect.poll(carCell).toBe(target.cellId);
  await expect(tid(page, 'hud-select')).toBeHidden();
  // the bots played and it is my turn again
  await expect(tid(page, 'hud-banner')).toHaveText('Your turn - drag your car');
  expect(errors).toEqual([]);
});

// Real touch on Phaser's hit test of a car token (the 40x30 touch area): a tap on a rival follows it (#135).
test("phone: tap a rival's car to follow it, tap it again to stop", async ({ page }) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 2, laps: 2 });
  await playMyTurn(page);
  // the bot whose token is the furthest from any of my targets: the tap cannot pick a target instead
  const rival = await page.evaluate(() => {
    const srp = window.__srp!;
    const targets = srp.state().movement.validTargets.map((t) => srp.cellScreenPos(t.cellId)!);
    return [2, 3]
      .map((carId) => {
        const pos = srp.tokenScreenPos(carId)!;
        const near = Math.min(...targets.map((t) => Math.hypot(t.x - pos.x, t.y - pos.y)));
        return { carId, pos, near };
      })
      .sort((a, b) => b.near - a.near)[0]!;
  });

  await page.touchscreen.tap(rival.pos.x, rival.pos.y);
  await expect(tid(page, 'hud-select')).toBeHidden();
  await expect(tid(page, 'hud-drawer-toggle')).toHaveClass(/is-following/);
  await tid(page, 'hud-drawer-toggle').tap();
  await expect(tid(page, 'hud-follow')).toBeVisible();
  await expect(tid(page, 'hud-follow-name')).toHaveText(`Car ${rival.carId}`);
  await expect(tid(page, 'hud-follow-row')).not.toHaveCount(0);
  await tid(page, 'hud-drawer-toggle').tap();

  await page.touchscreen.tap(rival.pos.x, rival.pos.y);
  await expect(tid(page, 'hud-drawer-toggle')).not.toHaveClass(/is-following/);
  await expect(tid(page, 'hud-follow')).toBeHidden();
  expect(errors).toEqual([]);
});

test('phone: the draft shows as a chip in the top bar without making it taller, down to an iPhone SE', async ({
  page
}) => {
  const errors = collectErrors(page);
  // The top bar is one line to the pixel at 844 px (an SE already wraps it to two): measure it without the chip first.
  await page.goto('/?sandbox&seed=0&rules=v2');
  await tid(page, 'home-quick').click();
  await setLobbySettings(page, { bots: 2, laps: 3 });
  await startRace(page);
  await expect(tid(page, 'hud-draft')).toBeHidden();
  const sizes = [
    { width: 844, height: 390 },
    { width: 667, height: 375 }
  ];
  const plain: number[] = [];
  for (const size of sizes) {
    await page.setViewportSize(size);
    plain.push((await tid(page, 'hud-card').boundingBox())!.height);
  }

  // Car 1 two cells behind car 2 in lane 1, two turns in the draft already: drafting, slingshot ready.
  const snap = await page.evaluate(() => window.__srp!.state());
  const at: Record<number, string> = { 1: 'Z05_L1_00', 2: 'Z07_L1_00', 3: 'Z20_L3_00' };
  const position = {
    ...snap,
    activeCarId: 1,
    cars: snap.cars.map((car) => ({
      ...car,
      cellId: at[car.carId]!,
      ...(car.carId === 1 ? { draftTurns: 2 } : {})
    }))
  };
  await page.goto(
    `/?sandbox&seed=0&rules=v2&pos=${encodeURIComponent(btoa(JSON.stringify(position)))}`
  );
  await tid(page, 'home-quick').click();
  await setLobbySettings(page, { bots: 2, laps: 3 });
  await startRace(page);

  // the cars are drawn where the position puts them, not on the grid
  const token = await page.evaluate(() => window.__srp!.tokenScreenPos(1));
  const cell = await page.evaluate(() => window.__srp!.cellScreenPos('Z05_L1_00'));
  expect(
    Math.hypot(token!.x - cell!.x, token!.y - cell!.y),
    JSON.stringify({ token, cell })
  ).toBeLessThan(2);

  for (const [i, size] of sizes.entries()) {
    await page.setViewportSize(size);
    const label = JSON.stringify(size);
    await expect(tid(page, 'hud-draft'), label).toBeVisible();
    await expect(tid(page, 'hud-draft-short'), label).toHaveText('» SLINGSHOT');
    await expect(tid(page, 'hud-draft-long'), label).toBeHidden();
    await expect
      .poll(async () => (await tid(page, 'hud-card').boundingBox())!.height, label)
      .toBe(plain[i]);
    const chip = (await tid(page, 'hud-draft').boundingBox())!;
    const toggle = (await tid(page, 'hud-drawer-toggle').boundingBox())!;
    expect(
      chip.x + chip.width,
      `${label} chip ${JSON.stringify(chip)} toggle ${JSON.stringify(toggle)}`
    ).toBeLessThanOrEqual(toggle.x);
  }
  // the board marks the slingshot targets; one of them is in reach only thanks to the draft
  const targets = await page.evaluate(() => window.__srp!.state().movement.validTargets);
  expect(targets.some((t) => t.slingshot)).toBe(true);
  expect(targets.some((t) => t.slingshotOnly)).toBe(true);

  // one move in the tow: the blue count, no slingshot yet (the leader is nowhere near: the tow is the last move's)
  const once = {
    ...position,
    cars: position.cars.map((car) => ({
      ...car,
      ...(car.carId === 1 ? { draftTurns: 1, cellId: 'Z05_L1_00' } : {}),
      ...(car.carId === 2 ? { cellId: 'Z18_L1_00' } : {})
    }))
  };
  await page.goto(
    `/?sandbox&seed=0&rules=v2&pos=${encodeURIComponent(btoa(JSON.stringify(once)))}`
  );
  await tid(page, 'home-quick').click();
  await setLobbySettings(page, { bots: 2, laps: 3 });
  await startRace(page);
  await expect(tid(page, 'hud-draft-short')).toHaveText('» DRAFT 1/2');
  await expect(tid(page, 'hud-draft')).not.toHaveClass(/is-ready/);
  const once2 = await page.evaluate(() =>
    window.__srp!.state().movement.validTargets.filter((t) => !t.isPitTrigger)
  );
  expect(once2.length).toBeGreaterThan(0);
  expect(once2.every((t) => t.drafted === true)).toBe(true);
  expect(once2.some((t) => t.slingshot)).toBe(false);
  expect(errors).toEqual([]);
});

test('phone: pinch zooms the board, one finger on the empty board pans it, a double tap fits it again', async ({
  page
}) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 2, laps: 2 });
  const viewport = page.viewportSize()!;
  const cdp = await page.context().newCDPSession(page);
  const touch = async (
    type: 'touchStart' | 'touchMove' | 'touchEnd',
    points: Array<{ x: number; y: number; id: number }>
  ) => {
    await cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: points.map((p) => ({ x: p.x, y: p.y, id: p.id }))
    });
  };
  const view = () => page.evaluate(() => window.__srp!.state() && window.__srp!.view());
  // a track cell as a ruler: where it is on screen now
  const cellAt = (id: string) =>
    page.evaluate((cellId) => window.__srp!.cellScreenPos(cellId)!, id);
  // somewhere on the board where no car stands, so a press there belongs to the board
  const emptySpot = () =>
    page.evaluate(
      ({ w, h }) => {
        const srp = window.__srp!;
        const tokens = srp.state().cars.map((c) => srp.tokenScreenPos(c.carId)!);
        for (let y = h * 0.45; y < h * 0.85; y += 12) {
          for (let x = w * 0.3; x < w * 0.7; x += 12) {
            if (tokens.every((t) => Math.hypot(t.x - x, t.y - y) > 60)) return { x, y };
          }
        }
        return { x: w / 2, y: h / 2 };
      },
      { w: viewport.width, h: viewport.height }
    );

  expect(await view()).toMatchObject({ userZoom: 1, fitVisible: false });
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const ruler = 'Z10_L2_00';
  const before = await cellAt(ruler);

  // pinch: two fingers 60 px apart go to 240 px apart
  await touch('touchStart', [
    { x: cx - 30, y: cy, id: 1 },
    { x: cx + 30, y: cy, id: 2 }
  ]);
  for (const half of [50, 70, 90, 110, 120]) {
    await touch('touchMove', [
      { x: cx - half, y: cy, id: 1 },
      { x: cx + half, y: cy, id: 2 }
    ]);
  }
  await touch('touchEnd', []);
  await expect.poll(async () => (await view()).userZoom).toBeGreaterThan(2);
  expect((await view()).fitVisible).toBe(true);
  await expect.poll(async () => (await cellAt(ruler)).x).not.toBeCloseTo(before.x, 0);

  // pan: one finger on the empty board moves the content with it
  const spot = await emptySpot();
  const panStart = await cellAt(ruler);
  await touch('touchStart', [{ x: spot.x, y: spot.y, id: 1 }]);
  for (const d of [8, 20, 40, 60, 80]) {
    await touch('touchMove', [{ x: spot.x - d, y: spot.y, id: 1 }]);
  }
  await touch('touchEnd', []);
  await expect.poll(async () => (await cellAt(ruler)).x).toBeLessThan(panStart.x - 40);

  // double tap on the empty board: fitted again, and the Fit button is gone
  const again = await emptySpot();
  await page.touchscreen.tap(again.x, again.y);
  await page.touchscreen.tap(again.x, again.y);
  await expect.poll(async () => (await view()).userZoom).toBe(1);
  expect((await view()).fitVisible).toBe(false);
  await expect.poll(async () => (await cellAt(ruler)).x).toBeCloseTo(before.x, 0);
  expect(errors).toEqual([]);
});

test("phone, zoomed in and panned away: the camera brings the car back to the middle on the player's next turn", async ({
  page
}) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 2, laps: 2 });
  const viewport = page.viewportSize()!;
  const middle = { x: viewport.width / 2, y: viewport.height / 2 };
  const car = await page.evaluate(() => {
    const srp = window.__srp!;
    return srp.tokenScreenPos(srp.state().activeCarId)!;
  });
  // zoom in about the car (the wheel: the same camera code as a pinch)
  await page.mouse.move(car.x, car.y);
  for (let i = 0; i < 3; i += 1) await page.mouse.wheel(0, -500);
  await expect
    .poll(async () => (await page.evaluate(() => window.__srp!.view())).userZoom)
    .toBeGreaterThan(1.5);
  const zoomed = await page.evaluate(() => window.__srp!.view());

  // pan the board so the car is well off to one side: a finger on empty grass above the track, dragged sideways
  const tokenNow = () =>
    page.evaluate(() => window.__srp!.tokenScreenPos(window.__srp!.state().activeCarId)!);
  const cdp = await page.context().newCDPSession(page);
  const finger = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', {
      type,
      touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }]
    });
  const grass = { x: middle.x, y: 90 };
  await finger('touchStart', grass.x, grass.y);
  for (const d of [10, 30, 60, 100, 140]) await finger('touchMove', grass.x + d, grass.y);
  await finger('touchEnd', grass.x, grass.y);
  await expect
    .poll(async () => Math.abs((await tokenNow()).x - middle.x))
    .toBeGreaterThan(viewport.width * 0.15);

  // play the nearest target by tap and Move here (still on screen)
  const target = await page.evaluate(() => {
    const srp = window.__srp!;
    const near = srp
      .state()
      .movement.validTargets.filter((t) => !t.isPitTrigger)
      .sort((a, b) => a.distance - b.distance)[0]!;
    return srp.cellScreenPos(near.cellId)!;
  });
  await page.touchscreen.tap(target.x, target.y);
  await tid(page, 'hud-select-confirm').tap();
  await expect(tid(page, 'hud-banner')).toHaveText('Your turn - drag your car', {
    timeout: 15_000
  });

  // the camera followed: still zoomed in, and the car is back in the middle across the board
  const after = await page.evaluate(() => {
    const srp = window.__srp!;
    return { view: srp.view(), token: srp.tokenScreenPos(srp.state().activeCarId)! };
  });
  expect(after.view.userZoom).toBeCloseTo(zoomed.userZoom, 1);
  expect(Math.abs(after.token.x - middle.x), JSON.stringify(after)).toBeLessThan(
    viewport.width * 0.08
  );
  expect(errors).toEqual([]);
});

test('phone with the browser bars showing (a short screen): the whole track stays on screen', async ({
  page
}) => {
  // Safari's address bar and tab strip leave about 300 px of an 844 x 390 phone. The page is sized to the visible
  // height (100dvh, see style.css); 100vh is the screen without the bars and would cut the bottom off.
  await page.setViewportSize({ width: 844, height: 300 });
  await quickRace(page, { bots: 3, laps: 1 });
  const track = await trackBox(page);
  const height = page.viewportSize()!.height;
  expect(track.t, JSON.stringify(track)).toBeGreaterThanOrEqual(0);
  expect(track.b, JSON.stringify(track)).toBeLessThan(height);
  const app = (await tid(page, 'race-canvas').boundingBox())!;
  expect(app.y + app.height).toBeLessThanOrEqual(height);
});

test('phone held upright: the race asks to turn it, carries on once it is turned, and the track fits the new size', async ({
  page
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await quickRace(page, { bots: 1, laps: 1 });
  await expect(tid(page, 'hud-rotate')).toBeVisible();
  await page.setViewportSize({ width: 844, height: 390 });
  await expect(tid(page, 'hud-rotate')).toBeHidden();
  await expect(tid(page, 'hud-banner')).toHaveText('Your turn - drag your car');
  // Phaser used to stay at the portrait size after the rotation (390x844 in an 844x390 window), so the track was laid out
  // for a tall screen: cut off at the bottom with an empty band above. It must fit like a race started in landscape.
  await expect
    .poll(() =>
      page.evaluate(() => document.querySelector('canvas')!.getBoundingClientRect().height)
    )
    .toBe(390);
  const canvas = await page.evaluate(() => {
    const r = document.querySelector('canvas')!.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
  });
  expect(canvas).toEqual([844, 390]);
  // the camera follows on the next frame (the e2e build runs at 10 fps)
  await expect.poll(async () => (await trackBox(page)).b).toBeLessThan(390);
  const track = await trackBox(page);
  expect(track.t, JSON.stringify(track)).toBeGreaterThanOrEqual(0);
});

test("phone, ?hidpi: the canvas is drawn at the screen's pixel density (capped at 2x), and the race plays", async ({
  page
}) => {
  const errors = collectErrors(page);
  // like quickRace, with the flag: main.ts reads it once at load, the router drops the query later
  await page.goto('/?seed=0&hidpi&rules=v2');
  await tid(page, 'home-quick').click();
  await setLobbySettings(page, { bots: 2, laps: 1 });
  await startRace(page);
  const size = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    const box = canvas.getBoundingClientRect();
    return {
      w: canvas.width,
      h: canvas.height,
      cssW: box.width,
      cssH: box.height,
      dpr: window.devicePixelRatio
    };
  });
  expect(size.dpr).toBe(3);
  // 3x screen, rendered at 2x: twice the CSS pixels, shown at the CSS size
  expect(Math.abs(size.w - size.cssW * 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(size.h - size.cssH * 2)).toBeLessThanOrEqual(2);
  await expect(tid(page, 'render-probe')).toContainText(`dpr 3 · canvas ${size.w}x${size.h}`);
  await expect(tid(page, 'render-probe')).toContainText('RaceScene on');
  await playMyTurn(page);
  await expect(tid(page, 'crash-report')).toBeHidden();
  expect(errors).toEqual([]);
});

test('phone, default: the canvas stays 1x (sharp rendering is opt-in) and there is no probe line', async ({
  page
}) => {
  await quickRace(page, { bots: 2, laps: 1 });
  const ratio = await page.evaluate(() => {
    const canvas = document.querySelector('canvas')!;
    return canvas.width / canvas.getBoundingClientRect().width;
  });
  expect(ratio).toBeCloseTo(1, 1);
  await expect(tid(page, 'render-probe')).toBeHidden();
});
