/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RaceSummary } from '../net/backend_api';
import { mountHistoryPage, raceDate } from './history_page';

const race = (id: string, over: Partial<RaceSummary> = {}): RaceSummary => ({
  id,
  finishedAt: Date.UTC(2026, 9, 24, 19, 10),
  source: 'online',
  trackId: 'oval16_3lanes',
  rulesVersion: 'v3',
  laps: 5,
  cars: 4,
  winnerCarId: 2,
  ...over
});

const tid = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

describe('history page (#170)', () => {
  const callbacks = { onBack: vi.fn(), onOpen: vi.fn(), onRetry: vi.fn() };
  let page: ReturnType<typeof mountHistoryPage>;

  beforeEach(() => {
    document.body.replaceChildren(document.createElement('div'));
    for (const fn of Object.values(callbacks)) fn.mockReset();
    page = mountHistoryPage(document.body.firstElementChild as HTMLElement, callbacks);
  });

  it('says it is loading, then lists the races newest first as the server gave them', () => {
    page.showLoading();
    expect(tid('history-loading').textContent).toContain('Loading');
    page.showRaces([
      race('a'),
      race('b', { source: 'solo', laps: 1, cars: 2, rulesVersion: 'v3' })
    ]);
    const rows = all('history-race');
    expect(rows.map((row) => row.dataset.race)).toEqual(['a', 'b']);
    expect(rows[0]!.textContent).toContain('Online');
    expect(rows[0]!.textContent).toContain('5 laps');
    expect(rows[0]!.textContent).toContain('4 cars');
    expect(rows[0]!.textContent).toContain('Car 2 won');
    expect(rows[1]!.textContent).toContain('Solo');
    expect(rows[1]!.textContent).toContain('1 lap');
    expect(rows[1]!.textContent).not.toContain('1 laps');
    expect(rows[1]!.textContent).toContain('v3');
  });

  it('opens a race when its row is selected, and goes back', () => {
    page.showRaces([race('a'), race('b')]);
    all('history-race')[1]!.click();
    expect(callbacks.onOpen).toHaveBeenCalledWith('b');
    tid('history-back').click();
    expect(callbacks.onBack).toHaveBeenCalledTimes(1);
  });

  it('lists a race of retired rules with its stats but does not open it, and says why', () => {
    page.showRaces([race('old', { rulesVersion: 'v2' })]);
    const row = all('history-race')[0]!;
    expect(row.textContent).toContain('v2 (retired)');
    expect(row.title).toContain('can no longer be replayed');
    row.click();
    expect(callbacks.onOpen).not.toHaveBeenCalled();
  });

  it('explains an empty history', () => {
    page.showRaces([]);
    expect(tid('history-empty').textContent).toContain('No race yet');
    expect(document.querySelector('[data-testid="history-list"]')).toBeNull();
  });

  it('shows what went wrong and offers to try again', () => {
    page.showError('The race history is not available right now.');
    expect(tid('history-error').textContent).toContain('not available');
    tid('history-retry').click();
    expect(callbacks.onRetry).toHaveBeenCalledTimes(1);
  });

  it('puts what the server sent in as text, never as markup', () => {
    page.showError('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img')).toBeNull();
    expect(tid('history-error').textContent).toBe('<img src=x onerror=alert(1)>');
  });

  it('dates a race in the language of the browser', () => {
    expect(raceDate(Date.UTC(2026, 9, 24, 19, 10), 'en-US')).toMatch(/Oct 24/);
  });
});
