import { expect, test } from '@playwright/test';
import {
  collectErrors,
  playMyTurn,
  playUntilFinished,
  quickRace,
  setLobbySettings,
  startRace,
  waitForMyTurn,
  waitForRace
} from './support/game';

// WebGL is the game's only renderer (#232, #237). It needs a real browser:
// the page must get a WebGL context, and leaving the race screen hides the container (0x0), which a WebGL framebuffer
// cannot be (a unit test cannot see that: it threw "Framebuffer status: Incomplete Attachment" at the end of a race).
test.setTimeout(90_000);

test('a race on a WebGL canvas, played to the end, then started again, with no errors', async ({
  page
}) => {
  const errors = collectErrors(page);
  await page.goto('/?seed=0&rules=v3');
  await page.getByTestId('home-quick').click();
  await setLobbySettings(page, { bots: 1, laps: 1 });
  await startRace(page);
  expect(
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas')!;
      return [canvas.getContext('2d') !== null, !!canvas.getContext('webgl')];
    })
  ).toEqual([false, true]);

  await playUntilFinished(page);
  await page.getByTestId('results-back-lobby').click();
  await page.getByTestId('lobby-start').click();
  await waitForRace(page);
  expect(errors).toEqual([]);
});

// A phone or a GPU reset can take the WebGL context away mid-race. Phaser restores its own textures; the ones we bake
// (the track, cars, badges, rings) must come back too, or the board stays broken until a reload.
test('a lost WebGL context comes back: the board looks the same and the race goes on', async ({
  page
}) => {
  const errors = collectErrors(page);
  await quickRace(page, { bots: 1, laps: 2 });
  await page.evaluate(() => window.__srp!.freezeAnimations());
  // the pointer rests where the grid setup panel's Cancel was: move it off the board so no button looks hovered, and
  // take the picture once two in a row agree
  await page.mouse.move(0, 0);
  let before = await page.screenshot();
  await expect
    .poll(async () => {
      const next = await page.screenshot();
      const same = next.equals(before);
      before = next;
      return same;
    })
    .toBe(true);

  await page.evaluate(async () => {
    const canvas = document.querySelector('canvas')!;
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const lose = gl!.getExtension('WEBGL_lose_context')!;
    const events: string[] = [];
    canvas.addEventListener('webglcontextlost', () => events.push('lost'));
    canvas.addEventListener('webglcontextrestored', () => events.push('restored'));
    lose.loseContext();
    await new Promise((resolve) => setTimeout(resolve, 300));
    lose.restoreContext();
    await new Promise((resolve) => setTimeout(resolve, 300));
    (window as unknown as { __ctxEvents: string[] }).__ctxEvents = events;
  });
  expect(
    await page.evaluate(() => (window as unknown as { __ctxEvents: string[] }).__ctxEvents)
  ).toEqual(['lost', 'restored']);
  await page.evaluate(() => window.__srp!.freezeAnimations());
  await expect.poll(async () => (await page.screenshot()).equals(before)).toBe(true);

  await playMyTurn(page);
  await waitForMyTurn(page);
  expect(errors).toEqual([]);
});
