import { trackName } from '../game/track_ids';
import {
  champion,
  isSeasonFinished,
  nextRaceIndex,
  placePoints,
  seasonStandings,
  type Season,
  type StandingRow
} from './season';

// The home screen's Championship card and the line the results screen adds (#273). DOM and text only.
export interface SeasonCardCallbacks {
  onNew: () => void;
  onNext: () => void;
  onStandings: () => void;
  onAbandon: () => void;
}

function humanRow(season: Season): StandingRow | undefined {
  return seasonStandings(season).find((row) => row.driver.human);
}

function youAre(season: Season): string {
  const me = humanRow(season);
  return me ? `you are P${me.rank}, ${me.points} points` : '';
}

/** "Race 2 of 4 · Big oval, 3 laps · you are P3, 12 points", or the champion once it is over. */
export function seasonStatus(season: Season): string {
  const next = nextRaceIndex(season);
  if (next === null) return `Champion: ${champion(season)?.name ?? '?'} · ${youAre(season)}`;
  const race = season.races[next];
  if (!race) return '';
  const laps = `${race.raceLaps} ${race.raceLaps === 1 ? 'lap' : 'laps'}`;
  const parts = [
    `Race ${next + 1} of ${season.races.length}`,
    `${trackName(race.trackId)}, ${laps}${race.reversedGrid ? ', reversed grid' : ''}`
  ];
  if (seasonStandings(season).some((row) => row.points > 0)) parts.push(youAre(season));
  return parts.join(' · ');
}

/** What the results screen says after race `raceIndex`: the points it gave and the place in the table, or the champion. */
export function seasonResultLine(season: Season, raceIndex: number): string {
  const me = humanRow(season);
  if (!me) return '';
  if (isSeasonFinished(season)) {
    return `Championship over: ${champion(season)?.name ?? '?'} wins · you finish P${me.rank} with ${me.points} points`;
  }
  const place = me.places[raceIndex];
  const gained = place ? placePoints(place) : 0;
  return `+${gained} points · P${me.rank} in the championship`;
}

function button(
  label: string,
  testid: string,
  onClick: () => void,
  primary = false
): HTMLButtonElement {
  const node = document.createElement('button');
  node.type = 'button';
  node.dataset.testid = testid;
  node.textContent = label;
  if (primary) node.className = 'primary';
  node.addEventListener('click', onClick);
  return node;
}

/**
 * No season: "New championship" (the cars and the bot level are picked on the Quick race card). Running: where it
 * stands, Next race, Standings and Abandon. Finished: the champion, Standings and New championship.
 */
export function renderSeasonCard(
  root: HTMLElement,
  season: Season | null,
  retired: boolean,
  callbacks: SeasonCardCallbacks
): void {
  const text = (value: string, testid: string, className = 'home-sub') => {
    const p = document.createElement('p');
    p.className = className;
    p.dataset.testid = testid;
    p.textContent = value;
    return p;
  };
  const title = document.createElement('h2');
  title.textContent = 'Championship';
  const nodes: Node[] = [title];
  if (retired) {
    nodes.push(
      text(
        'Your championship used rules that are no longer available, so it was removed.',
        'season-notice',
        'notice'
      )
    );
  }
  if (!season) {
    nodes.push(
      text(
        '4 races against the same bots, F1 points, the grid reversed in race 3.',
        'season-intro'
      ),
      button('New championship', 'season-new', callbacks.onNew)
    );
  } else if (isSeasonFinished(season)) {
    nodes.push(
      text(seasonStatus(season), 'season-status'),
      button('Standings', 'season-standings', callbacks.onStandings),
      button('New championship', 'season-new', callbacks.onNew)
    );
  } else {
    nodes.push(
      text(seasonStatus(season), 'season-status'),
      button('Next race', 'season-next', callbacks.onNext, true),
      button('Standings', 'season-standings', callbacks.onStandings),
      button('Abandon', 'season-abandon', callbacks.onAbandon)
    );
  }
  root.replaceChildren(...nodes);
}
