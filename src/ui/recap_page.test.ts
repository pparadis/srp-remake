/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import track from '../../public/tracks/oval16_3lanes.json';
import {
  applyAction,
  createRace,
  createRaceContext,
  decideBotAction,
  getActiveCar,
  type RaceSeat
} from '../game/race/race_engine';
import { logAction, startRaceLog } from '../game/race/race_log';
import { raceRecap } from '../game/systems/race_recap';
import type { TrackData } from '../game/types/track';
import { mountRecapPage } from './recap_page';

const ctx = createRaceContext(track as unknown as TrackData);
const SEATS: RaceSeat[] = [
  { isBot: true, ownerId: 'BOT1', botLevel: 'normal' },
  { isBot: true, ownerId: 'BOT2', botLevel: 'hard' },
  { isBot: true, ownerId: 'BOT3', botLevel: 'easy' }
];

// A v3 race between three bots to the flag; one name is HTML, to check that it is shown as text.
function recapOfARace() {
  const state = createRace(ctx, SEATS, 8, 4, 'v3');
  const log = startRaceLog(SEATS, 8, 4, 'v3');
  while (state.winnerCarId === null) {
    const action = decideBotAction(ctx, state).action;
    expect(applyAction(ctx, state, action).ok).toBe(true);
    logAction(log, action);
    expect(getActiveCar(state)).toBeDefined();
  }
  return raceRecap(ctx, log, (id) => (id === 1 ? '<img src=x onerror=alert(1)>' : `Racer ${id}`));
}

const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

describe('recap page (#169)', () => {
  const recap = recapOfARace();
  const onBack = vi.fn();

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    onBack.mockReset();
    mountRecapPage(document.getElementById('root')!, onBack).show(recap, 'Solo, 8 laps');
  });

  it('opens on the summary: one row per car in finishing order, and the title', () => {
    expect(tid('recap-title').textContent).toBe('Solo, 8 laps');
    const rows = all('recap-car');
    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.dataset.car)).toEqual(recap.cars.map((c) => String(c.carId)));
    expect(rows[0]!.textContent).toContain('P');
  });

  it('shows names as text, never as markup', () => {
    expect(document.querySelector('#root img')).toBeNull();
    expect(tid('recap-summary').textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('a click on a car shows its pit choices and every move', () => {
    const car = recap.cars[0]!;
    tid('recap-car').click();
    expect(tid('recap-title').textContent).toBe(car.name);
    expect(all('recap-move')).toHaveLength(car.moves.length);
    if (car.pitStops.length > 0) expect(all('recap-pit')).toHaveLength(car.pitStops.length);
    else expect(tid('recap-no-pits')).not.toBeNull();
    expect(tid('recap-car-line').textContent).toContain(`P${car.place} at the flag`);
  });

  it('steps through the turns with Previous and Next, and stops at the ends', () => {
    tid('recap-open-turns').click();
    // the page redraws on every step: look the counter up each time
    const count = () => tid('recap-turn-count').textContent;
    expect(count()).toBe(`1 / ${recap.turns.length}`);
    expect(tid('recap-prev')).toHaveProperty('disabled', true);
    tid('recap-next').click();
    expect(count()).toBe(`2 / ${recap.turns.length}`);
    expect(tid('recap-turn-detail').textContent).toContain('Turn 2');
    tid('recap-prev').click();
    expect(count()).toBe(`1 / ${recap.turns.length}`);
    for (let i = 1; i < recap.turns.length; i += 1) tid('recap-next').click();
    expect(count()).toBe(`${recap.turns.length} / ${recap.turns.length}`);
    expect(tid('recap-next')).toHaveProperty('disabled', true);
  });

  it('a click on a turn row jumps to it', () => {
    tid('recap-open-turns').click();
    all('recap-turn')[4]!.click();
    expect(tid('recap-turn-count').textContent).toBe(`5 / ${recap.turns.length}`);
    expect(tid('recap-turn-detail').textContent).toContain('Turn 5');
  });

  it("a car's own turns list only its turns, and Back climbs one level at a time", () => {
    const car = recap.cars[1]!;
    all('recap-car')[1]!.click();
    tid('recap-car-turns').click();
    const mine = recap.turns.filter((turn) => turn.carId === car.carId);
    expect(all('recap-turn')).toHaveLength(mine.length);
    tid('recap-back').click(); // turns of the car -> the car
    expect(all('recap-move')).toHaveLength(car.moves.length);
    tid('recap-back').click(); // the car -> the summary
    expect(all('recap-car')).toHaveLength(3);
    expect(onBack).not.toHaveBeenCalled();
    tid('recap-back').click(); // the summary -> out of the page
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
