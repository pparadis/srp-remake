import type { RaceSummary } from '../net/backend_api';
import { replayBlock } from '../game/rules/ids';

// The public history of races (#170): a list of the latest finished races from the server, each one opening as a recap.
// DOM only, no Phaser. `show*` fill it as the request goes: loading, the list, or what went wrong.
export interface HistoryCallbacks {
  onBack: () => void;
  onOpen: (raceId: string) => void;
  onRetry: () => void;
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

/** "Oct 24, 3:10 PM": a race is dated the way the player's browser says. */
export function raceDate(finishedAt: number, locale?: string): string {
  return new Date(finishedAt).toLocaleString(locale, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

export function mountHistoryPage(
  root: HTMLElement,
  callbacks: HistoryCallbacks
): {
  showLoading: () => void;
  showRaces: (races: RaceSummary[]) => void;
  showError: (message: string) => void;
} {
  const body = h('div', { class: 'recap-body', 'data-testid': 'history-body' });
  root.replaceChildren(
    h(
      'div',
      { class: 'recap-head' },
      button('Back', 'history-back', callbacks.onBack),
      h('h1', {}, 'Race history')
    ),
    body
  );
  const note = (text: string, testid: string) =>
    h('p', { class: 'recap-hint', 'data-testid': testid }, text);

  return {
    showLoading() {
      body.replaceChildren(note('Loading the latest races…', 'history-loading'));
    },
    showError(message) {
      body.replaceChildren(
        note(message, 'history-error'),
        button('Try again', 'history-retry', callbacks.onRetry)
      );
    },
    showRaces(races) {
      if (races.length === 0) {
        body.replaceChildren(
          note(
            'No race yet. Online races are added when they finish, and solo races when their player shares them.',
            'history-empty'
          )
        );
        return;
      }
      const rows = races.map((race) => {
        const blocked = replayBlock(race.rulesVersion);
        const row = h(
          'tr',
          {
            'data-testid': 'history-race',
            'data-race': race.id,
            ...(blocked ? { title: blocked } : { class: 'recap-click' })
          },
          h('td', {}, raceDate(race.finishedAt)),
          h('td', {}, race.source === 'online' ? 'Online' : 'Solo'),
          h('td', {}, `${race.laps} ${race.laps === 1 ? 'lap' : 'laps'}`),
          h('td', {}, `${race.cars} cars`),
          h('td', {}, blocked ? `${race.rulesVersion} (retired)` : race.rulesVersion),
          h('td', {}, `Car ${race.winnerCarId} won`)
        );
        if (!blocked) row.addEventListener('click', () => callbacks.onOpen(race.id));
        return row;
      });
      body.replaceChildren(
        h(
          'table',
          { class: 'recap-table', 'data-testid': 'history-list' },
          h(
            'thead',
            {},
            h(
              'tr',
              {},
              ...['When', 'Played', 'Length', 'Field', 'Rules', 'Result'].map((l) => h('th', {}, l))
            )
          ),
          h('tbody', {}, ...rows)
        ),
        note(
          `The latest ${races.length}. Select a race for its recap and the board replay.`,
          'history-hint'
        )
      );
    }
  };
}
