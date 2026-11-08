/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest';
import { mountSeasonPage } from './season_page';
import { newSeason, recordResult, type Season } from './season';

function page(hasRecap: (id: string) => boolean = () => true) {
  const root = document.createElement('div');
  const onOpenRecap = vi.fn();
  const mounted = mountSeasonPage(root, { onBack: vi.fn(), onOpenRecap, hasRecap });
  return { root, onOpenRecap, ...mounted };
}

const open = () => newSeason(7, 3, 'normal', 'v4', 1);

describe('the championship page (#273)', () => {
  it('lists the drivers by points with a column per race', () => {
    const season = recordResult(open(), 0, [2, 1, 3, 4], 'r0');
    const { root, show } = page();
    show(season, 1);
    expect(root.querySelector('[data-testid="season-headline"]')?.textContent).toBe('Race 2 of 4');
    const rows = [...root.querySelectorAll('[data-testid="season-row"]')];
    expect(rows.map((row) => row.getAttribute('data-car'))).toEqual(['2', '1', '3', '4']);
    expect(
      rows.map((row) => row.querySelector('[data-testid="season-points"]')?.textContent)
    ).toEqual(['25', '18', '15', '12']);
    expect(rows[1]?.textContent).toContain('P2 · 18');
    expect(rows[1]?.textContent).toContain('–');
    expect(root.querySelectorAll('[data-testid="season-race"]')).toHaveLength(4);
    expect(root.textContent).toContain('2. Big oval, 3 laps');
    expect(root.textContent).toContain('3. Oval, 3 laps · reversed grid');
  });

  it('puts the names in as text, never as markup', () => {
    const season: Season = {
      ...open(),
      drivers: open().drivers.map((d) =>
        d.human ? d : { ...d, name: '<img src=x onerror=alert(1)>' }
      )
    };
    const { root, show } = page();
    show(season, 0);
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('links a race to its recap only while the saved race is still there', () => {
    let season = recordResult(open(), 0, [2, 1, 3, 4], 'kept');
    season = recordResult(season, 1, [2, 1, 3, 4], 'dropped');
    season = recordResult(season, 2, [2, 1, 3, 4], null);
    const { root, show, onOpenRecap } = page((id) => id === 'kept');
    show(season, 3);
    const links = root.querySelectorAll<HTMLButtonElement>('[data-testid="season-recap"]');
    expect([...links].map((link) => link.dataset.race)).toEqual(['kept']);
    links[0]!.click();
    expect(onOpenRecap).toHaveBeenCalledWith('kept');
  });

  it('shows the champion once the last race is done, and marks a forfeit', () => {
    let season = open();
    for (let i = 0; i < 4; i += 1) season = recordResult(season, i, [3, 2, 4, 1], null);
    const { root, show } = page();
    show(season, null);
    expect(root.querySelector('[data-testid="season-headline"]')?.textContent).toBe(
      `Champion: ${season.drivers[2]?.name}`
    );

    const forfeited: Season = {
      ...open(),
      races: open().races.map((race, i) =>
        i === 0
          ? { ...race, result: { order: [2, 3, 4, 1], savedRaceId: null, forfeit: true } }
          : race
      )
    };
    show(forfeited, 1);
    expect(root.textContent).toContain('forfeit');
  });
});
