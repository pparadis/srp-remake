import { PERSONALITIES } from '../game/systems/bot_style';
import { trackName } from '../game/track_ids';
import { champion, placePoints, seasonStandings, type Season } from '../game/season';

// The standings of the championship (#273): drivers by points, one column per race with the place and the points. DOM
// only, no engine. Every name goes in as text.
export interface SeasonPageCallbacks {
  onBack: () => void;
  onOpenRecap: (savedRaceId: string) => void;
  /** Whether the saved race of a result is still in this browser (it keeps only the last 10). */
  hasRecap: (savedRaceId: string) => boolean;
}

function h(
  tag: string,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string | null>
): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) if (child !== null) node.append(child);
  return node;
}

function button(label: string, testid: string, onClick: () => void): HTMLButtonElement {
  const node = h('button', { type: 'button', 'data-testid': testid }, label) as HTMLButtonElement;
  node.addEventListener('click', onClick);
  return node;
}

/** "Race 2 of 4" while it runs, the champion once it is over. */
export function seasonHeadline(season: Season, nextIndex: number | null): string {
  if (nextIndex === null) return `Champion: ${champion(season)?.name ?? '?'}`;
  return `Race ${nextIndex + 1} of ${season.races.length}`;
}

export function mountSeasonPage(
  root: HTMLElement,
  callbacks: SeasonPageCallbacks
): { show: (season: Season, nextIndex: number | null) => void } {
  const body = h('div', { class: 'recap-body', 'data-testid': 'season-body' });
  root.replaceChildren(
    h(
      'div',
      { class: 'recap-head' },
      button('Back', 'season-back', callbacks.onBack),
      h('h1', {}, 'Championship')
    ),
    body
  );

  return {
    show(season, nextIndex) {
      const headers = season.races.map((race, i) => {
        const result = race.result;
        const link =
          result?.savedRaceId && callbacks.hasRecap(result.savedRaceId) ? result.savedRaceId : null;
        const label = `${i + 1}. ${trackName(race.trackId)}, ${race.raceLaps} ${race.raceLaps === 1 ? 'lap' : 'laps'}`;
        const cell = h('th', { 'data-testid': 'season-race' });
        if (link) {
          const open = button(label, 'season-recap', () => callbacks.onOpenRecap(link));
          open.dataset.race = link;
          cell.append(open);
        } else {
          cell.append(label);
        }
        if (race.reversedGrid) cell.append(h('small', {}, ' · reversed grid'));
        if (result?.forfeit) cell.append(h('small', {}, ' · forfeit'));
        return cell;
      });
      const rows = seasonStandings(season).map((row) => {
        const style = row.driver.style ? PERSONALITIES[row.driver.style].label : null;
        return h(
          'tr',
          { 'data-testid': 'season-row', 'data-car': String(row.driver.carId) },
          h('td', {}, String(row.rank)),
          h('td', {}, row.driver.name, style ? h('small', {}, ` · ${style}`) : null),
          h('td', { 'data-testid': 'season-points' }, String(row.points)),
          ...row.places.map((place) =>
            h('td', {}, place === null ? '–' : `P${place} · ${placePoints(place)}`)
          )
        );
      });
      body.replaceChildren(
        h('p', { 'data-testid': 'season-headline' }, seasonHeadline(season, nextIndex)),
        h(
          'table',
          { class: 'recap-table', 'data-testid': 'season-table' },
          h(
            'thead',
            {},
            h('tr', {}, h('th', {}, '#'), h('th', {}, 'Driver'), h('th', {}, 'Points'), ...headers)
          ),
          h('tbody', {}, ...rows)
        ),
        h(
          'p',
          { class: 'recap-hint', 'data-testid': 'season-hint' },
          'F1 points: 25, 18, 15, 12, 10, 8, 6, 4, 2, 1. A tie goes to the most wins, then the most second places. Select a race for its recap.'
        )
      );
    }
  };
}
