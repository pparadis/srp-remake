import { expect, test } from '@playwright/test';
import {
  collectErrors,
  playUntilFinished,
  setLobbySettings,
  startRace,
  waitForRace
} from './support/game';

// WebGL is the game's default renderer (#232); the e2e build runs on it too, and this spec asks for it by URL so it holds in any build. It needs a real browser:
// the page must get a WebGL context, and leaving the race screen hides the container (0x0), which a WebGL framebuffer
// cannot be (a unit test cannot see that: it threw "Framebuffer status: Incomplete Attachment" at the end of a race).
test.setTimeout(90_000);

test('?renderer=webgl: a race on a WebGL canvas, played to the end, then started again, with no errors', async ({
  page
}) => {
  const errors = collectErrors(page);
  await page.goto('/?seed=0&rules=v2&renderer=webgl');
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
