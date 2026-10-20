// Race HUD as a DOM overlay. `renderHud` is pure over the snapshot RaceScene emits as `srp:hud`.
import {
  DRAFT_SLINGSHOT_TURNS,
  MOVE_BUDGET,
  SQUEEZE_SURCHARGE_PER_CAR,
  type WingLevel
} from '../game/constants';
import { must } from '../game/must';
import type { PitAdvice, StintEstimate } from '../game/systems/strategy';
import type { FeedKind } from '../game/systems/race_feed';
import { isCompactHud } from './layout';

export interface HudCar {
  carId: number;
  name: string;
  /** CSS colour of the car sprite. */
  color: string;
  isBot: boolean;
  /** A bot's driving style (seeded personality), shown next to its name; absent for humans. */
  style?: string;
  /** The lap the car is in (1-based); 0 while it is still behind the start line. */
  lap: number;
  /** Crossed the line after the last lap. */
  finished: boolean;
  /** Cells covered from the start line (negative behind it): laps completed * spineLen + lap position (a fraction on the outer lanes). */
  progress: number;
  /** forwardIndex of the cell the car stands on. */
  fwd: number;
  tire: number;
  fuel: number;
  compound: 'soft' | 'hard';
  wing: WingLevel;
  state: 'ACTIVE' | 'PITTING' | 'WAITING' | 'DNF';
  pitTurns: number;
  /** Distance spent in each move of the current cycle, and which one is next. */
  cycle: number[];
  cycleIndex: number;
  /** Move budget left in the cycle, and the whole budget of this car's setup (Low wing and soft add, High takes). */
  remaining: number;
  budget: number;
  /** A pit stop is done (and not repeatable until the car is back on the main lanes). */
  pitServiced: boolean;
  /** In the tow: the car's last move ended tucked in behind a car, so its next move wears less. `draftTurns` is how
   * many moves in a row did (the slingshot needs 2). */
  drafting: boolean;
  draftTurns: number;
  /** Racing left on the current tire and fuel at this car's setup (see strategy.ts). */
  stint: Pick<StintEstimate, 'laps' | 'moves'>;
  advice: PitAdvice;
}

export interface HudHover {
  /** Page coordinates of the target cell. */
  x: number;
  y: number;
  distance: number;
  moveSpend: number;
  tireCost: number;
  fuelCost: number;
  isPit: boolean;
  /** Set for a squeeze target: cars passed (each adds SQUEEZE_SURCHARGE_PER_CAR move points). */
  squeezePassed?: number;
  /** Set when the route changes lane 2 or more times (every lane change costs a move point). */
  laneChanges?: number;
  /** The car is in the tow for this move: its tire and fuel cost carry the discount. */
  drafted?: boolean;
  /** A lane change of a car tucked in twice in a row: the surcharge was waived. */
  slingshot?: boolean;
  /** A slingshot that would be out of reach with the surcharge: the tow opens this move. */
  slingshotOnly?: boolean;
  /** The move ends 1-2 cells behind a car in its lane: the car is in the tow for its next move too. */
  tucksIn?: boolean;
  /** The active car's tire and fuel (percent) before the move, to show what is left after it. */
  tireBefore: number;
  fuelBefore: number;
}

export interface HudSnapshot {
  raceLaps: number;
  /** Cells in one lap, to turn a progress difference into laps. */
  spineLen: number;
  finished: boolean;
  winnerCarId: number | null;
  /** The local player's car (online: their seat; solo: the first human). */
  myCarId: number | null;
  activeCarId: number;
  /** The local player may drag the active car right now. */
  canControl: boolean;
  /** All cars in standings order. */
  cars: HudCar[];
  hover: HudHover | null;
  /** Tap to move: the target the local player picked, with Move here / Cancel. */
  selection?: HudHover | null;
  /** The active car is boxed in: no main-lane target, only squeeze targets (and maybe the pit entry). */
  boxedIn?: boolean;
  /** With boxedIn: the car is stuck at the pit exit (squeezes out onto lane 1). */
  pitExitBlocked?: boolean;
  /** Sandbox races only: editing (cars can be dragged anywhere) or playing from the edited position. */
  sandbox?: 'edit' | 'play';
  /** Full cell debug, only while the F overlay is on. */
  debugText: string | null;
  /** The race feed, oldest first (only the followed car's lines while one is). `mine`: about the local player's car. */
  log: Array<{ text: string; kind: FeedKind; mine: boolean }>;
  /** The car the player follows (a standings row or its token clicked, #135) and its moves over its last lap. */
  follow?: { carId: number; moves: HudMove[] } | null;
}

/** One move of a followed car. */
export interface HudMove {
  /** The lap it ended in (as HudCar.lap). */
  lap: number;
  /** Cells gained (lap position, as the standings). */
  cells: number;
  /** Move points spent; null when not known (online, the car's move cycle rolled over on that move). */
  moveSpend: number | null;
  tireUsed: number;
  fuelUsed: number;
  /** A pit stop: tire and fuel refilled. */
  pit: boolean;
}

const HEAD =
  '<thead><tr><th>#</th><th></th><th>Car</th><th>Lap</th><th>Gap</th><th></th></tr></thead>';

const TEMPLATE = `
<div class="hud-banner" data-testid="hud-banner"></div>
<div class="hud-turnbar">
  <span class="hud-timer" data-testid="hud-timer" hidden></span>
  <button type="button" class="hud-force-skip" data-testid="hud-force-skip" hidden>Skip their turn</button>
</div>
<div class="hud-left">
  <section class="hud-card" data-testid="hud-card">
    <div class="hud-card-head">
      <span class="hud-chip" data-testid="hud-chip"></span>
      <span class="hud-name" data-testid="hud-name"></span>
      <span class="hud-state" data-testid="hud-state" hidden></span>
    </div>
    <div class="hud-lap" data-testid="hud-lap"></div>
    <div class="hud-lap-hint" data-testid="hud-lap-hint" hidden>Cross the start line to begin lap 1</div>
    <div class="hud-pos" data-testid="hud-position"></div>
    <div class="hud-meter"><span data-testid="hud-tire"></span><span class="hud-compound" data-testid="hud-compound"></span><span class="hud-wing" data-testid="hud-wing"></span>
      <div class="hud-bar"><i data-testid="hud-tire-bar"></i></div></div>
    <div class="hud-meter"><span data-testid="hud-fuel"></span>
      <div class="hud-bar"><i data-testid="hud-fuel-bar"></i></div></div>
    <div class="hud-stint" data-testid="hud-stint"></div>
    <div class="hud-draft" data-testid="hud-draft" hidden><span class="hud-draft-long" data-testid="hud-draft-long"></span><span class="hud-draft-short" data-testid="hud-draft-short"></span></div>
    <div class="hud-advice" data-testid="hud-advice" hidden></div>
    <div class="hud-warning" data-testid="hud-warning" hidden></div>
    <div class="hud-meter"><span>Moves</span><span data-testid="hud-budget"></span>
      <div class="hud-pips" data-testid="hud-pips"></div></div>
  </section>
  <div class="hud-hint" data-testid="hud-hint">F: fwd overlay &middot; C: cars+moves &middot; M: sound</div>
  <button type="button" class="hud-mute" data-testid="hud-mute" aria-pressed="false">Sound: on</button>
</div>
<button type="button" class="hud-drawer-toggle" data-testid="hud-drawer-toggle" aria-expanded="false">Standings<span class="hud-drawer-dot" data-testid="hud-drawer-dot" aria-label="Unread chat" hidden></span></button>
<div class="hud-right">
  <table class="hud-standings" data-testid="hud-standings">${HEAD}<tbody></tbody></table>
  <section class="hud-follow" data-testid="hud-follow" hidden>
    <div class="hud-follow-head"><span class="hud-chip" data-testid="hud-follow-chip"></span><span class="hud-follow-name" data-testid="hud-follow-name"></span><span class="hud-follow-sub">last lap</span>
      <button type="button" class="hud-follow-clear" data-testid="hud-follow-clear">All cars</button></div>
    <div class="hud-follow-scroll"><table class="hud-follow-moves" data-testid="hud-follow-moves"><thead><tr><th>Lap</th><th>Cells</th><th>Pts</th><th>Tire</th><th>Fuel</th></tr></thead><tbody></tbody></table></div>
  </section>
  <details class="hud-feed" data-testid="hud-feed"><summary>Race feed<span data-testid="hud-feed-filter"></span></summary><ol data-testid="hud-feed-list"></ol></details>
  <details class="hud-chat" data-testid="hud-chat" hidden>
    <summary>Chat<span class="hud-chat-unread" data-testid="hud-chat-unread" hidden></span></summary>
    <div class="hud-chat-body" data-testid="hud-chat-body"></div>
  </details>
  <button type="button" class="hud-fps-toggle" data-testid="hud-fps-toggle" aria-pressed="false">FPS: off</button>
</div>
<div class="hud-fps" data-testid="hud-fps" hidden></div>
<div class="hud-toast" data-testid="hud-toast" role="status" hidden></div>
<div class="hud-tooltip" data-testid="hud-tooltip" hidden></div>
<div class="hud-select" data-testid="hud-select" hidden>
  <div class="hud-select-info" data-testid="hud-select-info"></div>
  <div class="hud-select-actions">
    <button type="button" class="hud-select-confirm" data-testid="hud-select-confirm">Move here</button>
    <button type="button" class="hud-select-cancel" data-testid="hud-select-cancel">Cancel</button>
  </div>
</div>
<pre class="hud-debug" data-testid="hud-debug" hidden></pre>
<div class="hud-rotate" data-testid="hud-rotate">Turn your phone sideways to race</div>
`;

export function mountHud(root: HTMLElement) {
  root.innerHTML = TEMPLATE;
  // The feed is the record of what the others did: open by default, except on a phone, where the drawer holds it (#92).
  if (!isCompactHud()) (q(root, 'hud-feed') as HTMLDetailsElement).open = true;
  // Compact layout (a phone in landscape): standings and the race feed sit in a drawer that this button opens.
  const toggle = q(root, 'hud-drawer-toggle');
  toggle.addEventListener('click', () => {
    const open = root.classList.toggle('is-drawer-open');
    toggle.setAttribute('aria-expanded', String(open));
  });
  const send = (detail: HudCommand) =>
    window.dispatchEvent(new CustomEvent<HudCommand>('srp:hud-command', { detail }));
  // Tap to move: the picked target's card asks the scene to play it, or to drop the pick.
  q(root, 'hud-select-confirm').addEventListener('click', () => send({ type: 'confirm-move' }));
  q(root, 'hud-select-cancel').addEventListener('click', () => send({ type: 'cancel-move' }));
  // Follow a car (#135): a click on its standings row (the rows are rebuilt on every render), All cars to stop.
  q(root, 'hud-standings').addEventListener('click', (event) => {
    const row = (event.target as Element).closest<HTMLElement>('tr[data-car-id]');
    if (row) send({ type: 'follow-car', carId: Number(row.dataset.carId) });
  });
  q(root, 'hud-follow-clear').addEventListener('click', () =>
    send({ type: 'follow-car', carId: null })
  );
}

/** What the HUD asks the race scene to do (`srp:hud-command` on window). */
export type HudCommand =
  | { type: 'confirm-move' | 'cancel-move' }
  /** Follow this car (the one already followed: stop), null: follow nobody. */
  | { type: 'follow-car'; carId: number | null };

function q(root: Element, id: string): HTMLElement {
  return must(root.querySelector<HTMLElement>(`[data-testid="${id}"]`), `HUD element ${id}`);
}

function tbodyOf(table: HTMLElement): HTMLElement {
  return must(table.querySelector('tbody'), 'table body');
}

/** ok / warn / crit, same 20% threshold the old canvas HUD used. */
export function resourceLevel(percent: number): 'ok' | 'warn' | 'crit' {
  if (percent < 20) return 'crit';
  if (percent < 40) return 'warn';
  return 'ok';
}

/** m:ss for a countdown; rounds up so it reads 0:01 until the very end. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** "≈ 2.1 laps (~17 moves)": racing left until tire or fuel is empty. */
export function formatStint(stint: Pick<StintEstimate, 'laps' | 'moves'>): string {
  if (stint.moves < 0.5) return 'Empty: no stint left';
  const laps = stint.laps < 0.1 ? '<0.1' : stint.laps.toFixed(1);
  return `≈ ${laps} laps (~${Math.round(stint.moves)} moves)`;
}

const ADVICE_LABEL: Partial<Record<PitAdvice, string>> = {
  'pit-soon': 'Pit this lap',
  'pit-now': 'Pit now'
};

/** The cap that applies once tire or fuel is gone (raceEngine: zeroResourceMax), or null. */
export function resourceWarning(car: Pick<HudCar, 'tire' | 'fuel'>): string | null {
  const gone = [car.tire <= 0 ? 'tire' : null, car.fuel <= 0 ? 'fuel' : null].filter(Boolean);
  if (gone.length === 0) return null;
  return `Out of ${gone.join(' and ')}: max ${MOVE_BUDGET.zeroResourceMax} moves`;
}

/** Tooltip content for a hovered target: the move and what tire and fuel are left after it. */
function renderTooltip(tip: HTMLElement, h: HudHover) {
  const part = (label: string, before: number, cost: number) => {
    const after = Math.max(0, before - cost);
    const span = document.createElement('span');
    span.className = `hud-${resourceLevel(after)}`;
    span.textContent = `${label} ${Math.round(before)}% → ${Math.round(after)}%`;
    return { span, empty: after <= 0 };
  };
  const squeeze = h.squeezePassed
    ? `Squeeze past ${h.squeezePassed} car${h.squeezePassed > 1 ? 's' : ''} - Move ${h.moveSpend} (+${h.squeezePassed * SQUEEZE_SURCHARGE_PER_CAR} points) - `
    : null;
  const lanes = h.laneChanges ? ` (${h.laneChanges} lane changes)` : '';
  const nodes: Array<string | HTMLElement> = [squeeze ?? `Move ${h.moveSpend}${lanes} - `];
  if (h.isPit) {
    nodes.push('PIT stop: tire and fuel refilled');
  } else {
    const tire = part('tire', h.tireBefore, h.tireCost);
    const fuel = part('fuel', h.fuelBefore, h.fuelCost);
    nodes.push(tire.span, ' - ', fuel.span);
    if (h.drafted || h.slingshot) {
      const note = document.createElement('div');
      note.className = 'hud-tooltip-draft';
      note.textContent = h.slingshotOnly
        ? 'Slingshot: only in reach thanks to the draft'
        : h.slingshot
          ? 'Slingshot: the lane change is free'
          : 'Draft: less wear';
      nodes.push(note);
    }
    if (h.tucksIn) {
      const note = document.createElement('div');
      note.className = 'hud-tooltip-draft';
      note.textContent = 'Ends in the tow: less wear next move';
      nodes.push(note);
    }
    const empties = [
      tire.empty && h.tireBefore > 0 ? 'tire' : null,
      fuel.empty && h.fuelBefore > 0 ? 'fuel' : null
    ].filter(Boolean);
    if (empties.length > 0) {
      const warn = document.createElement('div');
      warn.className = 'hud-crit hud-tooltip-warn';
      warn.textContent = `Empties your ${empties.join(' and ')}: max ${MOVE_BUDGET.zeroResourceMax} moves next`;
      nodes.push(warn);
    }
  }
  tip.replaceChildren(...nodes);
}

/**
 * The card of a picked target: the move, then Move here / Pit here and Cancel. It sits beside the cell, on the side
 * with room, so it stays on screen and off the cell itself.
 */
function renderSelection(card: HTMLElement, sel: HudHover | null) {
  card.hidden = !sel;
  if (!sel) return;
  renderTooltip(q(card, 'hud-select-info'), sel);
  q(card, 'hud-select-confirm').textContent = sel.isPit ? 'Pit here' : 'Move here';
  card.style.left = `${sel.x}px`;
  card.style.top = `${sel.y}px`;
  card.classList.toggle('is-left', sel.x > window.innerWidth * 0.55);
  card.classList.toggle('is-below', sel.y < window.innerHeight * 0.45);
}

export function renderMute(root: Element, muted: boolean) {
  const button = q(root, 'hud-mute');
  button.textContent = muted ? 'Sound: off' : 'Sound: on';
  button.setAttribute('aria-pressed', String(muted));
}

/** The frame-rate readout (P key, `?fps`): the line shows `text` while `on`; the touch button follows the state. */
export function renderFps(root: Element, on: boolean, text: string) {
  const line = q(root, 'hud-fps');
  line.hidden = !on;
  line.textContent = on ? text : '';
  const button = q(root, 'hud-fps-toggle');
  button.textContent = on ? 'FPS: on' : 'FPS: off';
  button.setAttribute('aria-pressed', String(on));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export type ToastKind = 'lap' | 'final' | 'slingshot' | 'draft';

/** A short banner in the middle of the race screen ("Lap 2 / 5", "Final lap", "Slingshot!"). */
export function showToast(root: Element, text: string, kind: ToastKind = 'lap', ms = 2500) {
  const toast = q(root, 'hud-toast');
  toast.textContent = text;
  toast.className = `hud-toast is-${kind}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}

/** "+5" cells behind the car ahead, or "+1L" once a whole lap or more behind. */
export function gapLabel(car: HudCar, ahead: HudCar | undefined, spineLen: number): string {
  if (!ahead) return '-';
  // progress is a lap position in fractions of a cell (#114); the label is whole cells
  const gap = Math.max(0, Math.round(ahead.progress - car.progress));
  return gap >= spineLen ? `+${Math.floor(gap / spineLen)}L` : `+${gap}`;
}

/** Lap column / card text: the lap the car is in, "Finished" once it crossed the line to end the race. */
function lapText(car: HudCar, raceLaps: number, short = false): string {
  if (car.finished) return short ? 'Fin' : 'Finished';
  return short ? `${car.lap}/${raceLaps}` : `Lap ${car.lap} / ${raceLaps}`;
}

export function bannerText(s: HudSnapshot): string {
  const winner = s.cars.find((c) => c.carId === s.winnerCarId);
  if (s.sandbox === 'edit') return 'Sandbox: editing - drag any car, E to play';
  if (s.finished) return `Race finished - ${winner ? winner.name : `Car ${s.winnerCarId}`} wins`;
  const active = s.cars.find((c) => c.carId === s.activeCarId);
  if (!active) return '';
  if (active.carId === s.myCarId && s.canControl && s.boxedIn) {
    if (s.pitExitBlocked) {
      return `Pit exit blocked - squeeze out (+${SQUEEZE_SURCHARGE_PER_CAR} points per car)`;
    }
    return `Boxed in - squeeze past (+${SQUEEZE_SURCHARGE_PER_CAR} points per car)`;
  }
  if (active.carId === s.myCarId) {
    return s.canControl ? 'Your turn - drag your car' : 'Waiting for the server';
  }
  if (active.isBot) return `Car ${active.carId} (bot) is playing`;
  return `Waiting for ${active.name}`;
}

function setMeter(valueEl: HTMLElement, barEl: HTMLElement, label: string, percent: number) {
  const pct = Math.max(0, Math.min(100, percent));
  valueEl.textContent = `${label} ${Math.round(pct)}%`;
  barEl.style.width = `${pct}%`;
  const level = resourceLevel(pct);
  valueEl.className = `hud-${level}`;
  barEl.className = `hud-${level}`;
}

function nameCell(car: HudCar): string | HTMLElement {
  if (!car.style) return car.name;
  const span = document.createElement('span');
  span.className = 'hud-style';
  span.textContent = ` · ${car.style}`;
  const cell = document.createElement('span');
  cell.append(car.name, span);
  return cell;
}

function fillStandings(tbody: Element, cars: HudCar[], s: HudSnapshot, rowId: string) {
  tbody.replaceChildren(
    ...cars.map((car, i) => {
      const tr = document.createElement('tr');
      tr.dataset.testid = rowId;
      tr.dataset.carId = String(car.carId);
      tr.classList.toggle('is-me', car.carId === s.myCarId);
      tr.classList.toggle('is-followed', car.carId === s.follow?.carId);
      tr.classList.toggle('is-active', !s.finished && car.carId === s.activeCarId);
      const chip = document.createElement('span');
      chip.className = 'hud-chip';
      chip.style.background = car.color;
      const icon = car.state === 'DNF' ? 'DNF' : car.state === 'PITTING' ? 'PIT' : '';
      const cells: Array<string | HTMLElement> = [
        String(i + 1),
        chip,
        nameCell(car),
        lapText(car, s.raceLaps, true),
        gapLabel(car, cars[i - 1], s.spineLen),
        icon
      ];
      for (const content of cells) {
        const td = document.createElement('td');
        td.append(content);
        tr.append(td);
      }
      return tr;
    })
  );
}

export function renderHud(root: HTMLElement, s: HudSnapshot) {
  const me = s.cars.find((c) => c.carId === s.myCarId);
  const banner = q(root, 'hud-banner');
  banner.textContent = bannerText(s);
  banner.className = `hud-banner${s.finished ? ' is-finished' : s.canControl ? (s.boxedIn ? ' is-mine is-boxed' : ' is-mine') : ''}`;

  q(root, 'hud-card').hidden = !me;
  if (me) {
    q(root, 'hud-chip').style.background = me.color;
    q(root, 'hud-name').textContent = me.name;
    q(root, 'hud-lap').textContent = lapText(me, s.raceLaps);
    q(root, 'hud-lap-hint').hidden = me.lap > 0 || me.finished;
    q(root, 'hud-position').textContent = `P${s.cars.indexOf(me) + 1} / ${s.cars.length}`;
    setMeter(q(root, 'hud-tire'), q(root, 'hud-tire-bar'), 'Tire', me.tire);
    setMeter(q(root, 'hud-fuel'), q(root, 'hud-fuel-bar'), 'Fuel', me.fuel);
    const compound = q(root, 'hud-compound');
    compound.textContent = me.compound.toUpperCase();
    compound.className = `hud-compound is-${me.compound}`;
    const wing = q(root, 'hud-wing');
    wing.textContent = me.wing === 'medium' ? 'MED' : me.wing.toUpperCase();
    wing.title = `${me.wing} wing`;
    q(root, 'hud-budget').textContent = `${me.remaining} / ${me.budget}`;
    q(root, 'hud-stint').textContent = formatStint(me.stint);
    const draft = q(root, 'hud-draft');
    const ready = me.draftTurns >= DRAFT_SLINGSHOT_TURNS;
    draft.hidden = !me.drafting;
    // the long line on the card, the short chip in the phone's top bar (style.css picks one)
    const run = Math.min(me.draftTurns, DRAFT_SLINGSHOT_TURNS);
    q(draft, 'hud-draft-long').textContent = ready
      ? 'In the tow - slingshot ready'
      : `In the tow ${run}/${DRAFT_SLINGSHOT_TURNS}`;
    q(draft, 'hud-draft-short').textContent = ready
      ? '» SLINGSHOT'
      : `» DRAFT ${run}/${DRAFT_SLINGSHOT_TURNS}`;
    draft.classList.toggle('is-ready', me.drafting && ready);
    // a pulse when the chip appears or its count goes up (CSS: none under prefers-reduced-motion)
    const towState = me.drafting ? String(run) : '';
    if (towState !== '' && towState !== draft.dataset.state) {
      draft.classList.remove('is-pulse');
      void draft.offsetWidth; // restart the animation when it was still running
      draft.classList.add('is-pulse');
    }
    draft.dataset.state = towState;
    const advice = q(root, 'hud-advice');
    const label = ADVICE_LABEL[me.advice];
    advice.hidden = !label;
    advice.textContent = label ?? '';
    advice.className = `hud-advice is-${me.advice}`;
    const warning = q(root, 'hud-warning');
    const warn = resourceWarning(me);
    warning.hidden = warn === null;
    warning.textContent = warn ?? '';
    q(root, 'hud-pips').replaceChildren(
      ...me.cycle.map((spent, i) => {
        const pip = document.createElement('i');
        pip.dataset.testid = 'hud-pip';
        pip.textContent = String(spent);
        pip.className = i === me.cycleIndex ? 'is-current' : spent > 0 ? 'is-used' : '';
        return pip;
      })
    );
    const state = q(root, 'hud-state');
    state.hidden = me.state !== 'PITTING' && me.state !== 'DNF';
    state.textContent =
      me.state === 'DNF' ? 'DNF' : `PITTING ${me.pitTurns} turn${me.pitTurns === 1 ? '' : 's'}`;
  }

  fillStandings(tbodyOf(q(root, 'hud-standings')), s.cars, s, 'hud-standing-row');

  const feed = q(root, 'hud-feed-list');
  feed.replaceChildren(
    ...s.log.map((line) => {
      const li = document.createElement('li');
      li.textContent = line.text;
      li.className = `is-${line.kind}${line.mine ? ' is-mine' : ''}`;
      return li;
    })
  );
  feed.scrollTop = feed.scrollHeight; // newest line at the bottom, in view
  renderFollow(root, s);

  const tip = q(root, 'hud-tooltip');
  tip.hidden = !s.hover;
  if (s.hover) {
    const h = s.hover;
    renderTooltip(tip, h);
    tip.style.left = `${h.x}px`;
    tip.style.top = `${h.y}px`;
  }
  renderSelection(q(root, 'hud-select'), s.selection ?? null);
  const dbg = q(root, 'hud-debug');
  dbg.hidden = s.debugText === null;
  dbg.textContent = s.debugText ?? '';
}

/** The followed car's panel: its moves over its last lap, newest first; the feed's title says whose lines it shows. */
function renderFollow(root: HTMLElement, s: HudSnapshot) {
  const followedId = s.follow?.carId;
  const car = s.cars.find((c) => c.carId === followedId);
  const panel = q(root, 'hud-follow');
  panel.hidden = !car;
  q(root, 'hud-feed-filter').textContent = car ? ` · ${car.name}` : '';
  q(root, 'hud-drawer-toggle').classList.toggle('is-following', car !== undefined);
  if (!car || !s.follow) return;
  q(root, 'hud-follow-chip').style.background = car.color;
  q(root, 'hud-follow-name').textContent = car.name;
  const row = (...cells: Array<string | [string, number]>) => {
    const tr = document.createElement('tr');
    tr.dataset.testid = 'hud-follow-row';
    for (const cell of cells) {
      const td = document.createElement('td');
      const [text, span] = typeof cell === 'string' ? [cell, 1] : cell;
      td.textContent = text;
      td.colSpan = span;
      tr.append(td);
    }
    return tr;
  };
  const used = (percent: number) => `-${Math.round(percent)}%`;
  const rows = [...s.follow.moves]
    .reverse()
    .map((m) =>
      row(
        String(m.lap),
        `+${m.cells}`,
        m.moveSpend === null ? '-' : String(m.moveSpend),
        ...(m.pit ? [['Pit stop', 2] as [string, number]] : [used(m.tireUsed), used(m.fuelUsed)])
      )
    );
  tbodyOf(q(root, 'hud-follow-moves')).replaceChildren(
    ...(rows.length > 0 ? rows : [row(['No moves yet', 5])])
  );
}

/** Final standings for the results overlay. */
export function renderResults(root: HTMLElement, s: HudSnapshot) {
  fillStandings(
    tbodyOf(q(root, 'results-standings')),
    s.cars,
    { ...s, finished: true, follow: null },
    'results-row'
  );
}
