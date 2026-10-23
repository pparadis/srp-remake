import { must } from '../game/must';
import type {
  CarRecap,
  PitChoice,
  RaceRecap,
  RecapMove,
  RecapTurn
} from '../game/systems/race_recap';
import type { CarSetup } from '../game/types/car';

// The recap page of a finished race (#169): the summary of every car, a car's moves and pit choices, and the race turn by
// turn. DOM only, no Phaser; names are the players' own text, so everything goes in with `textContent`.

export type RecapView =
  | { kind: 'summary' }
  | { kind: 'car'; carId: number }
  /** `carId`: only that car's turns; `at`: the turn shown in detail (an index in the shown list). */
  | { kind: 'turns'; carId: number | null; at: number };

interface Parts {
  back: HTMLButtonElement;
  title: HTMLElement;
  body: HTMLElement;
}

type Child = Node | string | null | false;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) if (child) node.append(child);
  return node;
}

function cell(text: string): HTMLElement {
  return h('td', {}, text);
}

function table(head: string[], rows: HTMLElement[], testid: string): HTMLElement {
  return h(
    'table',
    { class: 'recap-table', 'data-testid': testid },
    h('thead', {}, h('tr', {}, ...head.map((label) => h('th', {}, label)))),
    h('tbody', {}, ...rows)
  );
}

function button(label: string, testid: string, onClick: () => void): HTMLButtonElement {
  const node = h('button', { type: 'button', 'data-testid': testid }, label) as HTMLButtonElement;
  node.addEventListener('click', onClick);
  return node;
}

function whole(value: number): string {
  return String(Math.round(value));
}

function tenth(value: number): string {
  return value.toFixed(1);
}

function setupText(setup: CarSetup): string {
  const fuel = setup.fuelLoad === undefined ? '' : `, ${setup.fuelLoad}% fuel`;
  return `${setup.compound} tires, ${setup.wing} wing${fuel}`;
}

function carLabel(car: CarRecap): string {
  return car.botLevel ? `${car.name} (bot ${car.botLevel})` : car.name;
}

function laneText(move: RecapMove): string {
  return move.fromLane === move.toLane
    ? `lane ${move.toLane}`
    : `lane ${move.fromLane} → ${move.toLane}`;
}

function flags(move: RecapMove, nameOf: (id: number) => string): string {
  return [
    move.pit ? 'pit stop' : '',
    move.passed.length > 0 ? `passes ${move.passed.map(nameOf).join(', ')}` : '',
    move.squeeze ? 'squeeze' : '',
    move.slingshot ? 'slingshot' : '',
    move.tow ? 'in the tow' : ''
  ]
    .filter(Boolean)
    .join(' · ');
}

function pitRows(stops: PitChoice[]): HTMLElement[] {
  return stops.map((stop) =>
    h(
      'tr',
      { 'data-testid': 'recap-pit' },
      cell(String(stop.lap)),
      cell(stop.setup.compound),
      cell(stop.setup.wing),
      cell(stop.setup.fuelLoad === undefined ? '-' : `${stop.setup.fuelLoad}%`),
      cell(`${whole(stop.tireBefore)}%`),
      cell(`${whole(stop.fuelBefore)}%`)
    )
  );
}

export function renderSummary(recap: RaceRecap, go: (view: RecapView) => void): HTMLElement {
  const rows = recap.cars.map((car) => {
    const row = h(
      'tr',
      { 'data-testid': 'recap-car', 'data-car': String(car.carId), class: 'recap-click' },
      cell(String(car.place)),
      cell(carLabel(car)),
      cell(`P${car.startPlace} → P${car.place}`),
      cell(`${car.laps}/${recap.raceLaps}`),
      cell(String(car.pitStops.length)),
      cell(`${car.passes} / ${car.timesPassed}`),
      cell(String(car.tows)),
      cell(setupText(car.gridSetup))
    );
    row.addEventListener('click', () => go({ kind: 'car', carId: car.carId }));
    return row;
  });
  return h(
    'div',
    {},
    table(
      ['#', 'Car', 'Grid → finish', 'Laps', 'Stops', 'Passes / passed', 'Tows', 'Grid setup'],
      rows,
      'recap-summary'
    ),
    h('p', { class: 'recap-hint' }, 'Select a car for its moves and pit choices.'),
    button('Turn by turn', 'recap-open-turns', () => go({ kind: 'turns', carId: null, at: 0 }))
  );
}

export function renderCar(
  recap: RaceRecap,
  carId: number,
  go: (view: RecapView) => void
): HTMLElement {
  const car = must(
    recap.cars.find((c) => c.carId === carId),
    'car of the recap'
  );
  const nameOf = (id: number) => recap.cars.find((c) => c.carId === id)?.name ?? `Car ${id}`;
  const moveRows = car.moves.map((move, i) =>
    h(
      'tr',
      { 'data-testid': 'recap-move' },
      cell(String(i + 1)),
      cell(String(move.lap)),
      cell(move.pit ? 'pit' : `+${move.cells}`),
      cell(String(move.moveSpend)),
      cell(laneText(move)),
      cell(`-${tenth(move.tireUsed)} → ${whole(move.tireAfter)}%`),
      cell(`-${tenth(move.fuelUsed)} → ${whole(move.fuelAfter)}%`),
      cell(`P${move.place}`),
      cell(flags(move, nameOf))
    )
  );
  return h(
    'div',
    {},
    h(
      'p',
      { 'data-testid': 'recap-car-line' },
      `${car.winner ? 'Winner. ' : ''}P${car.startPlace} on the grid, P${car.place} at the flag, ` +
        `${car.passes} passes and passed ${car.timesPassed} times. Grid setup: ${setupText(car.gridSetup)}.`
    ),
    h('h2', {}, 'Pit stops'),
    car.pitStops.length > 0
      ? table(
          ['Lap', 'Tires', 'Wing', 'Fuel load', 'Tire on arrival', 'Fuel on arrival'],
          pitRows(car.pitStops),
          'recap-pits'
        )
      : h('p', { 'data-testid': 'recap-no-pits' }, 'No pit stop.'),
    h('h2', {}, 'Moves'),
    table(
      ['#', 'Lap', 'Cells', 'Move points', 'Lane', 'Tire', 'Fuel', 'Place', ''],
      moveRows,
      'recap-moves'
    ),
    button('Its turns', 'recap-car-turns', () => go({ kind: 'turns', carId, at: 0 }))
  );
}

function turnText(turn: RecapTurn, nameOf: (id: number) => string): string {
  const said = turn.lines.map((line) => line.text);
  return said.length > 0 ? said.join('. ') : `${nameOf(turn.carId)}: ${turn.kind}`;
}

export function renderTurns(
  recap: RaceRecap,
  view: Extract<RecapView, { kind: 'turns' }>,
  go: (view: RecapView) => void
): HTMLElement {
  const nameOf = (id: number) => recap.cars.find((c) => c.carId === id)?.name ?? `Car ${id}`;
  const shown = recap.turns.filter((turn) => view.carId === null || turn.carId === view.carId);
  const at = Math.max(0, Math.min(shown.length - 1, view.at));
  const current = shown[at];
  const rows = shown.map((turn, i) => {
    const row = h(
      'tr',
      {
        'data-testid': 'recap-turn',
        class: i === at ? 'recap-click is-current' : 'recap-click'
      },
      cell(String(turn.index + 1)),
      cell(nameOf(turn.carId)),
      cell(turnText(turn, nameOf))
    );
    row.addEventListener('click', () => go({ ...view, at: i }));
    return row;
  });
  const detail = current
    ? h(
        'div',
        { class: 'recap-detail', 'data-testid': 'recap-turn-detail' },
        h('b', {}, `Turn ${current.index + 1}: ${nameOf(current.carId)}`),
        // a turn the feed has nothing to say about (a grid setup that changed nothing) still gets its line
        ...(current.lines.length > 0
          ? current.lines.map((line) => h('div', {}, line.text))
          : [h('div', {}, turnText(current, nameOf))]),
        current.move
          ? h(
              'div',
              { class: 'recap-hint' },
              `${current.move.pit ? 'Pit stop' : `+${current.move.cells} cells`} for ${current.move.moveSpend} move points, ` +
                `${laneText(current.move)}, tire ${whole(current.move.tireAfter)}%, fuel ${whole(current.move.fuelAfter)}%, P${current.move.place}.`
            )
          : null
      )
    : h('p', {}, 'No turn.');
  const step = (delta: number) =>
    go({ ...view, at: Math.max(0, Math.min(shown.length - 1, at + delta)) });
  const prev = button('Previous', 'recap-prev', () => step(-1));
  const next = button('Next', 'recap-next', () => step(1));
  prev.disabled = at <= 0;
  next.disabled = at >= shown.length - 1;
  return h(
    'div',
    {},
    h(
      'p',
      { class: 'recap-hint' },
      view.carId === null
        ? `All ${shown.length} turns.`
        : `${nameOf(view.carId)}: ${shown.length} turns.`
    ),
    h(
      'div',
      { class: 'recap-nav' },
      prev,
      next,
      h(
        'span',
        { 'data-testid': 'recap-turn-count' },
        `${shown.length > 0 ? at + 1 : 0} / ${shown.length}`
      )
    ),
    detail,
    table(['#', 'Car', 'What happened'], rows, 'recap-turns')
  );
}

/** Builds the recap page inside `root`. `show` fills it; Back goes up one level, and from the summary calls `onBack`. */
export function mountRecapPage(
  root: HTMLElement,
  onBack: () => void
): { show: (recap: RaceRecap, title: string) => void } {
  const parts: Parts = {
    back: h('button', { type: 'button', 'data-testid': 'recap-back' }, 'Back') as HTMLButtonElement,
    title: h('h1', { 'data-testid': 'recap-title' }),
    body: h('div', { class: 'recap-body' })
  };
  root.replaceChildren(h('div', { class: 'recap-head' }, parts.back, parts.title), parts.body);
  let recap: RaceRecap | null = null;
  let heading = '';
  let view: RecapView = { kind: 'summary' };

  const render = () => {
    if (!recap) return;
    const go = (next: RecapView) => {
      view = next;
      render();
      root.scrollTo?.(0, 0);
    };
    const carName = (id: number) => recap?.cars.find((c) => c.carId === id)?.name ?? `Car ${id}`;
    parts.title.textContent =
      view.kind === 'summary'
        ? heading
        : view.kind === 'car'
          ? carName(view.carId)
          : view.carId === null
            ? 'Turn by turn'
            : `Turn by turn: ${carName(view.carId)}`;
    parts.body.replaceChildren(
      view.kind === 'summary'
        ? renderSummary(recap, go)
        : view.kind === 'car'
          ? renderCar(recap, view.carId, go)
          : renderTurns(recap, view, go)
    );
  };

  parts.back.addEventListener('click', () => {
    if (view.kind === 'summary') onBack();
    else if (view.kind === 'turns' && view.carId !== null) {
      view = { kind: 'car', carId: view.carId };
      render();
    } else {
      view = { kind: 'summary' };
      render();
    }
  });
  return {
    show(next, title) {
      recap = next;
      heading = title;
      view = { kind: 'summary' };
      render();
    }
  };
}
