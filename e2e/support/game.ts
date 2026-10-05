import { expect, type Page } from "@playwright/test";

// eslint-disable-next-line no-undef -- Node-side Playwright code
const BACKEND_ORIGIN = `http://localhost:${process.env.E2E_BACKEND_PORT ?? "3001"}`;

/** Collects console errors and uncaught page errors; assert `errors` is empty at the end of a test. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`console: ${msg.text()}`);
  });
  page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

/** Journey guardrail: console errors, page errors and failed or non-2xx backend requests. */
export function guard(page: Page): string[] {
  const errors = collectErrors(page);
  page.on("requestfailed", (req) => {
    const failure = req.failure()?.errorText ?? "";
    // reloads and closed pages abort in-flight requests on purpose
    if (req.url().startsWith(BACKEND_ORIGIN) && !failure.includes("ERR_ABORTED")) {
      errors.push(`requestfailed: ${req.method()} ${req.url()} ${failure}`);
    }
  });
  page.on("response", (res) => {
    if (res.url().startsWith(BACKEND_ORIGIN) && res.status() >= 400) {
      errors.push(`response ${res.status()}: ${res.request().method()} ${res.url()}`);
    }
  });
  return errors;
}

type SrpStatus = { raceLaps: number; winnerCarId: number | null; canControl: boolean; activeOwnerId: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function gotoHome(page: Page) {
  await page.goto("/");
  await expect(page.getByTestId("home-quick")).toBeVisible();
}

export async function setName(page: Page, name: string) {
  await page.getByTestId("home-name").fill(name);
  await page.getByTestId("home-name").press("Tab"); // fires change -> remembered for invite links
}

export async function setLobbySettings(
  page: Page,
  s: { bots?: number; laps?: number; timer?: 0 | 30 | 60 | 120 }
) {
  if (s.timer !== undefined) await page.getByTestId("lobby-turn-timer").selectOption(String(s.timer));
  if (s.bots !== undefined) await page.getByTestId("lobby-bots").selectOption(String(s.bots));
  if (s.laps !== undefined) {
    await page.getByTestId("lobby-laps").fill(String(s.laps));
    await page.getByTestId("lobby-laps").press("Tab");
  }
}

/** Waits until the race scene is built and exposes its test hook. */
export async function waitForRace(page: Page) {
  await expect(page.locator("canvas")).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(() => window.__srp !== undefined && window.__srp.state().cars.length > 0);
}

export async function startRace(page: Page) {
  await page.getByTestId("lobby-start").click();
  await waitForRace(page);
}

/** Home -> Quick race -> settings -> Start; ends on the Race screen. */
export async function quickRace(page: Page, opts: { bots?: number; laps?: number } = {}) {
  await gotoHome(page);
  await page.getByTestId("home-quick").click();
  await setLobbySettings(page, { bots: opts.bots ?? 2, laps: opts.laps ?? 1 });
  await startRace(page);
}

/** Host creates an online lobby (turn timer Off unless `timer` is set); returns its invite URL. */
export async function createLobby(
  page: Page,
  opts: { name?: string; bots?: number; laps?: number; timer?: 0 | 30 | 60 | 120 } = {}
): Promise<string> {
  await gotoHome(page);
  if (opts.name) await setName(page, opts.name);
  await page.getByTestId("home-create").click();
  await expect(page.getByTestId("lobby-title")).toBeVisible();
  // No turn timer unless a spec asks for one: journeys must not race the auto-play.
  await setLobbySettings(page, { ...opts, timer: opts.timer ?? 0 });
  const invite = page.getByTestId("lobby-invite-link");
  await expect(invite).toHaveValue(/\/lobby\/[^/]+$/);
  return invite.inputValue();
}

/** Opens an invite link as a new player and waits until the lobby shows them. */
export async function joinByInvite(page: Page, inviteUrl: string, name = "Guest") {
  await gotoHome(page);
  await setName(page, name);
  await page.goto(inviteUrl);
  await expect(page.getByTestId("lobby-player").filter({ hasText: `${name} (you)` })).toBeVisible();
}

const status = (page: Page) => page.evaluate(() => window.__srp?.status() as SrpStatus | undefined);

/** Resolves once the local player may move, or the race is already decided. */
export async function waitForMyTurn(page: Page, timeout = 60_000) {
  await page.waitForFunction(
    () => {
      const s = window.__srp?.status();
      return s !== undefined && (s.canControl || s.winnerCarId !== null);
    },
    undefined,
    { timeout }
  );
}

/** Which of the pages may move now? null once the race is decided. */
export async function nextMover(pages: Page[], timeout = 60_000): Promise<Page | null> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const page of pages) {
      const s = await status(page);
      if (s?.winnerCarId != null) return null;
      if (s?.canControl) return page;
    }
    await sleep(100);
  }
  throw new Error("nobody got a turn within the timeout");
}

/** Drags the active car to the furthest valid non-pit target with the real mouse. */
export async function playMyTurn(page: Page) {
  await waitForMyTurn(page);
  const plan = await page.evaluate(() => {
    const srp = window.__srp!;
    if (srp.status().winnerCarId !== null) return null;
    const state = srp.state();
    const car = state.cars.find((c) => c.carId === state.activeCarId)!;
    const target = state.movement.validTargets
      .filter((t) => !t.isPitTrigger)
      .sort((a, b) => b.distance - a.distance)[0];
    if (!target) return { error: "no valid non-pit target" as const, carId: car.carId, cellId: car.cellId };
    return {
      carId: car.carId,
      cellId: car.cellId,
      from: srp.cellScreenPos(car.cellId)!,
      to: srp.cellScreenPos(target.cellId)!
    };
  });
  if (!plan) return;
  if ("error" in plan) throw new Error(`${plan.error} for car ${plan.carId} at ${plan.cellId}`);
  await page.mouse.move(plan.from.x, plan.from.y);
  await page.mouse.down();
  await page.mouse.move(plan.to.x, plan.to.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(
    ({ carId, cellId }) => {
      const srp = window.__srp;
      if (!srp) return true; // page navigated away: the race is over
      if (srp.status().winnerCarId !== null) return true;
      return srp.state().cars.find((c) => c.carId === carId)?.cellId !== cellId;
    },
    { carId: plan.carId, cellId: plan.cellId },
    { timeout: 10_000 }
  );
}

/** Plays turns on a single (offline) page until the race has a winner. */
export async function playUntilFinished(page: Page, maxTurns = 200) {
  for (let i = 0; i < maxTurns; i += 1) {
    await waitForMyTurn(page);
    if ((await status(page))?.winnerCarId != null) return;
    await playMyTurn(page);
  }
  throw new Error(`race not finished after ${maxTurns} turns`);
}

export const carCells = (page: Page) =>
  page.evaluate(() =>
    JSON.stringify(
      window.__srp!.state().cars.map((c) => [c.carId, c.cellId, c.lapCount, c.tire, c.fuel])
    )
  );

/** Every page shows the same cars (cell, lap, tire, fuel). */
export async function expectSameCars(pages: Page[]) {
  await expect
    .poll(async () => new Set(await Promise.all(pages.map(carCells))).size, { timeout: 10_000 })
    .toBe(1);
}

/** Standings as the HUD shows them: car id, lap and gap per row, in order. */
export const hudStandings = (page: Page) =>
  page.evaluate(() =>
    JSON.stringify(
      [...document.querySelectorAll('[data-testid="hud-standing-row"]')]
        .map((row) => [row.getAttribute("data-car-id"), ...[...row.children].slice(3, 5).map((td) => td.textContent)])
    )
  );

/** Every page's HUD shows the same standings order, laps and gaps. */
export async function expectSameHud(pages: Page[]) {
  await expect
    .poll(async () => new Set(await Promise.all(pages.map(hudStandings))).size, { timeout: 10_000 })
    .toBe(1);
}

/**
 * Lets whoever has the turn play. Agreement between pages (cars + HUD) is checked on the first
 * `checkFirst` turns, then every `checkEvery`th turn, and always after the final turn.
 */
export async function playOnlineRace(
  pages: Page[],
  opts: { maxTurns?: number; stopAfter?: number; checkFirst?: number; checkEvery?: number } = {}
) {
  const maxTurns = opts.maxTurns ?? 300;
  const checkFirst = opts.checkFirst ?? 3;
  const checkEvery = opts.checkEvery ?? 4;
  const agree = async () => {
    await expectSameCars(pages);
    await expectSameHud(pages);
  };
  let unchecked = false;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (opts.stopAfter !== undefined && turn >= opts.stopAfter) break;
    const mover = await nextMover(pages);
    if (!mover) break;
    await playMyTurn(mover);
    unchecked = true;
    if (turn < checkFirst || (turn + 1) % checkEvery === 0) {
      await agree();
      unchecked = false;
    }
    if (turn === maxTurns - 1) throw new Error(`race not finished after ${maxTurns} turns`);
  }
  // final turn (race decided or stopAfter reached): always verify
  if (unchecked) await agree();
}
