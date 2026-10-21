/** @vitest-environment jsdom */
// The link between the race session and the DOM HUD: hud.test.ts renders hand-built snapshots, this one the
// snapshots a real race produces (what the e2e HUD checks used to cover through a browser).
import { beforeEach, describe, expect, it } from 'vitest';
import indexHtml from '../../index.html?raw';
import track from '../../public/tracks/oval16_3lanes.json';
import type { TrackData } from '../game/types/track';
import { RaceSession } from '../game/race/race_session';
import { mountHud, renderHud, renderResults } from './hud';

const TRACK = track as unknown as TrackData;

function newSession(botCars: number, raceLaps: number) {
  return new RaceSession(TRACK, {
    totalCars: 1 + botCars,
    humanCars: 1,
    botCars,
    raceLaps,
    seed: 0
  });
}

function render(session: RaceSession, hover: { cellId: string } | null = null) {
  const snapshot = session.hudSnapshot({
    hoverCell: hover ? session.cellMap.get(hover.cellId)! : null,
    showCarsAndMoves: true,
    showForwardIndex: false,
    cellScreenPos: () => ({ x: 300, y: 200 })
  })!;
  renderHud(hud(), snapshot);
  renderResults(document.body, snapshot);
}

function playMyTurn(session: RaceSession) {
  session.recomputeTargets();
  const [cellId] = [...session.validTargets]
    .filter(([, t]) => !t.isPitTrigger)
    .sort((a, b) => b[1].distance - a[1].distance)[0]!;
  session.applyLocal({ type: 'move', targetCellId: cellId });
  session.runBots();
  session.recomputeTargets();
}

const hud = () => document.getElementById('hud')!;
const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

describe('race session -> HUD', () => {
  beforeEach(() => {
    document.body.innerHTML = /<body[^>]*>([\s\S]*)<\/body>/
      .exec(indexHtml)![1]!
      .replace(/<script[\s\S]*?<\/script>/g, '');
    mountHud(hud());
  });

  it('shows the card, banner and standings of a new race, and follows them after a move', () => {
    const session = newSession(2, 2);
    session.recomputeTargets();
    render(session);
    expect(tid('hud-lap').textContent).toBe('Lap 1 / 2');
    expect(tid('hud-lap-hint').hidden).toBe(true);
    expect(tid('hud-banner').textContent).toBe('Your turn - drag your car');
    expect(all('hud-pip')).toHaveLength(5);
    expect(tid('hud-tire').textContent).toBe('Tire 100%');
    expect(tid('hud-compound').textContent).toMatch(/^(SOFT|HARD)$/);
    expect(tid('hud-advice').hidden).toBe(true);
    expect(tid('hud-warning').hidden).toBe(true);
    expect(tid('hud-stint').textContent).toMatch(/^≈ \d\.\d laps \(~\d+ moves\)$/);

    playMyTurn(session);
    render(session);
    const me = session.localCar()!;
    expect(tid('hud-lap').textContent).toBe(`Lap ${(me.lapCount ?? 0) + 1} / 2`);
    expect(tid('hud-tire').textContent).toBe(`Tire ${Math.round(me.tire)}%`);
    expect(tid('hud-fuel').textContent).toBe(`Fuel ${Math.round(me.fuel)}%`);
    expect(tid('hud-position').textContent).toMatch(/^P\d \/ 3$/);
    expect(all('hud-standing-row')).toHaveLength(3);
    expect(tid('hud-feed-list').children.length).toBeGreaterThan(1);
  });

  it('following a bot shows its moves and only its feed lines (#135)', () => {
    const session = newSession(2, 2);
    session.followCar(2);
    playMyTurn(session);
    playMyTurn(session);
    render(session);
    expect(tid('hud-follow').hidden).toBe(false);
    expect(tid('hud-follow-name').textContent).toBe('Car 2');
    expect(all('hud-follow-row')).toHaveLength(session.followedMoves().length);
    expect(session.followedMoves()).toHaveLength(2);
    const lines = [...tid('hud-feed-list').children].map((li) => li.textContent);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((line) => line!.startsWith('Car 2'))).toBe(true);
  });

  it('a car behind the line reads lap 0/N in the standings, pole 1/N', () => {
    const session = newSession(3, 2);
    render(session);
    const row = (carId: number) =>
      document.querySelector(`[data-testid="hud-standing-row"][data-car-id="${carId}"]`)!;
    expect(row(4).textContent).toContain('0/2');
    expect(row(1).textContent).toContain('1/2');
  });

  it('hovering a target shows its cost in the tooltip', () => {
    const session = newSession(0, 1);
    session.recomputeTargets();
    const [cellId, t] = [...session.validTargets].find(([, target]) => !target.isPitTrigger)!;
    render(session);
    expect(tid('hud-tooltip').hidden).toBe(true);
    render(session, { cellId });
    const tip = tid('hud-tooltip');
    expect(tip.hidden).toBe(false);
    const car = session.activeCar;
    const pct = (before: number, cost: number) =>
      `${Math.round(before)}% → ${Math.round(Math.max(0, before - cost))}%`;
    expect(tip.textContent).toMatch(/^Move \d+ - tire \d+% → \d+% - fuel \d+% → \d+%$/);
    expect(tip.textContent).toContain(
      `tire ${pct(car.tire, t.tireCost)} - fuel ${pct(car.fuel, t.fuelCost)}`
    );
    expect(tip.style.left).toBe('300px');
  });

  it('rules v3: the card says the cap, the heavy tank and the pace, and the tooltip the fuel a cell (#148)', () => {
    const session = new RaceSession(TRACK, {
      totalCars: 1,
      humanCars: 1,
      botCars: 0,
      raceLaps: 5,
      seed: 0,
      rulesVersion: 'v3'
    });
    session.recomputeTargets();
    const [cellId] = [...session.validTargets].find(([, target]) => !target.isPitTrigger)!;
    render(session, { cellId });
    // dealt medium tires and 95% fuel: heavy, and a medium car can keep an 8 over 5 laps
    expect(tid('hud-compound').textContent).toBe('MED');
    expect(tid('hud-pace').hidden).toBe(false);
    expect(tid('hud-pace').textContent).toMatch(
      /^Max 8 a move · HEAVY \(-1 pace\) · pace to the flag: [789]$/
    );
    expect(tid('hud-tooltip').textContent).toMatch(
      /uses \d+\.\d tire, \d+\.\d fuel \(0\.\d\d fuel a cell\)/
    );
  });

  it('before rules v3 the card has no cap line and the tooltip no rate', () => {
    const session = newSession(0, 1);
    session.recomputeTargets();
    const [cellId] = [...session.validTargets].find(([, target]) => !target.isPitTrigger)!;
    render(session, { cellId });
    expect(tid('hud-pace').hidden).toBe(true);
    expect(tid('hud-tooltip').textContent).not.toContain('a cell');
  });

  it('the results table shows the winner first and the final standings', () => {
    const session = newSession(2, 1);
    for (let turn = 0; turn < 60 && !session.finished; turn += 1) playMyTurn(session);
    render(session);
    expect(tid('hud-banner').textContent).toContain('Race finished');
    const rows = all('results-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.dataset.carId).toBe(String(session.winnerCarId));
    expect(rows[0]!.textContent).toContain('Fin');
  });
});
