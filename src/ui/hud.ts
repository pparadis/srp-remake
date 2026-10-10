// Race HUD as a DOM overlay. `renderHud` is pure over the snapshot RaceScene emits as `srp:hud`.
import { MOVE_BUDGET, MOVE_CYCLE, SQUEEZE_SURCHARGE_PER_CAR } from "../game/constants";
import type { PitAdvice, StintEstimate } from "../game/systems/strategy";

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
  /** Cells covered from the start line (negative behind it): laps completed * spineLen + forwardIndex. */
  progress: number;
  /** forwardIndex of the cell the car stands on. */
  fwd: number;
  tire: number;
  fuel: number;
  compound: "soft" | "hard";
  state: "ACTIVE" | "PITTING" | "WAITING" | "DNF";
  pitTurns: number;
  /** Distance spent in each move of the current cycle, and which one is next. */
  cycle: number[];
  cycleIndex: number;
  /** Move budget left in the cycle (of 40). */
  remaining: number;
  /** A pit stop is done (and not repeatable until the car is back on the main lanes). */
  pitServiced: boolean;
  /** Racing left on the current tire and fuel at this car's setup (see strategy.ts). */
  stint: Pick<StintEstimate, "laps" | "moves">;
  advice: PitAdvice;
}

interface HudHover {
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
  /** The active car is boxed in: only squeeze targets exist. */
  boxedIn?: boolean;
  /** With boxedIn: the car is stuck at the pit exit (squeezes out onto lane 1). */
  pitExitBlocked?: boolean;
  /** Sandbox races only: editing (cars can be dragged anywhere) or playing from the edited position. */
  sandbox?: "edit" | "play";
  /** Full cell debug, only while the F overlay is on. */
  debugText: string | null;
  log: string[];
}

const HEAD =
  "<thead><tr><th>#</th><th></th><th>Car</th><th>Lap</th><th>Gap</th><th></th></tr></thead>";

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
    <div class="hud-meter"><span data-testid="hud-tire"></span><span class="hud-compound" data-testid="hud-compound"></span>
      <div class="hud-bar"><i data-testid="hud-tire-bar"></i></div></div>
    <div class="hud-meter"><span data-testid="hud-fuel"></span>
      <div class="hud-bar"><i data-testid="hud-fuel-bar"></i></div></div>
    <div class="hud-stint" data-testid="hud-stint"></div>
    <div class="hud-advice" data-testid="hud-advice" hidden></div>
    <div class="hud-warning" data-testid="hud-warning" hidden></div>
    <div class="hud-meter"><span>Moves</span><span data-testid="hud-budget"></span>
      <div class="hud-pips" data-testid="hud-pips"></div></div>
  </section>
  <div class="hud-hint" data-testid="hud-hint">F: fwd overlay &middot; C: cars+moves &middot; M: sound</div>
  <button type="button" class="hud-mute" data-testid="hud-mute" aria-pressed="false">Sound: on</button>
</div>
<button type="button" class="hud-drawer-toggle" data-testid="hud-drawer-toggle" aria-expanded="false">Standings</button>
<div class="hud-right">
  <table class="hud-standings" data-testid="hud-standings">${HEAD}<tbody></tbody></table>
  <details class="hud-feed" data-testid="hud-feed"><summary>Race feed</summary><ol data-testid="hud-feed-list"></ol></details>
</div>
<div class="hud-toast" data-testid="hud-toast" role="status" hidden></div>
<div class="hud-tooltip" data-testid="hud-tooltip" hidden></div>
<pre class="hud-debug" data-testid="hud-debug" hidden></pre>
<div class="hud-rotate" data-testid="hud-rotate">Turn your phone sideways to race</div>
`;

export function mountHud(root: HTMLElement) {
  root.innerHTML = TEMPLATE;
  // Compact layout (a phone in landscape): standings and the race feed sit in a drawer that this button opens.
  const toggle = q(root, "hud-drawer-toggle");
  toggle.addEventListener("click", () => {
    const open = root.classList.toggle("is-drawer-open");
    toggle.setAttribute("aria-expanded", String(open));
  });
}

const q = (root: Element, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;

/** ok / warn / crit, same 20% threshold the old canvas HUD used. */
export function resourceLevel(percent: number): "ok" | "warn" | "crit" {
  if (percent < 20) return "crit";
  if (percent < 40) return "warn";
  return "ok";
}

/** m:ss for a countdown; rounds up so it reads 0:01 until the very end. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** "≈ 2.1 laps (~17 moves)": racing left until tire or fuel is empty. */
export function formatStint(stint: Pick<StintEstimate, "laps" | "moves">): string {
  if (stint.moves < 0.5) return "Empty: no stint left";
  const laps = stint.laps < 0.1 ? "<0.1" : stint.laps.toFixed(1);
  return `≈ ${laps} laps (~${Math.round(stint.moves)} moves)`;
}

const ADVICE_LABEL: Partial<Record<PitAdvice, string>> = { "pit-soon": "Pit this lap", "pit-now": "Pit now" };

/** The cap that applies once tire or fuel is gone (raceEngine: zeroResourceMax), or null. */
export function resourceWarning(car: Pick<HudCar, "tire" | "fuel">): string | null {
  const gone = [car.tire <= 0 ? "tire" : null, car.fuel <= 0 ? "fuel" : null].filter(Boolean);
  if (gone.length === 0) return null;
  return `Out of ${gone.join(" and ")}: max ${MOVE_BUDGET.zeroResourceMax} moves`;
}

/** Tooltip content for a hovered target: the move and what tire and fuel are left after it. */
function renderTooltip(tip: HTMLElement, h: HudHover) {
  const part = (label: string, before: number, cost: number) => {
    const after = Math.max(0, before - cost);
    const span = document.createElement("span");
    span.className = `hud-${resourceLevel(after)}`;
    span.textContent = `${label} ${Math.round(before)}% → ${Math.round(after)}%`;
    return { span, empty: after <= 0 };
  };
  const squeeze = h.squeezePassed
    ? `Squeeze past ${h.squeezePassed} car${h.squeezePassed > 1 ? "s" : ""} - Move ${h.moveSpend} (+${h.squeezePassed * SQUEEZE_SURCHARGE_PER_CAR} points) - `
    : null;
  const lanes = h.laneChanges ? ` (${h.laneChanges} lane changes)` : "";
  const nodes: Array<string | HTMLElement> = [squeeze ?? `Move ${h.moveSpend}${lanes} - `];
  if (h.isPit) {
    nodes.push("PIT stop: tire and fuel refilled");
  } else {
    const tire = part("tire", h.tireBefore, h.tireCost);
    const fuel = part("fuel", h.fuelBefore, h.fuelCost);
    nodes.push(tire.span, " - ", fuel.span);
    const empties = [tire.empty && h.tireBefore > 0 ? "tire" : null, fuel.empty && h.fuelBefore > 0 ? "fuel" : null].filter(Boolean);
    if (empties.length > 0) {
      const warn = document.createElement("div");
      warn.className = "hud-crit hud-tooltip-warn";
      warn.textContent = `Empties your ${empties.join(" and ")}: max ${MOVE_BUDGET.zeroResourceMax} moves next`;
      nodes.push(warn);
    }
  }
  tip.replaceChildren(...nodes);
}

export function renderMute(root: Element, muted: boolean) {
  const button = q(root, "hud-mute");
  button.textContent = muted ? "Sound: off" : "Sound: on";
  button.setAttribute("aria-pressed", String(muted));
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** A short banner in the middle of the race screen ("Lap 2 / 5", "Final lap"). */
export function showToast(root: Element, text: string, kind: "lap" | "final" = "lap", ms = 2500) {
  const toast = q(root, "hud-toast");
  toast.textContent = text;
  toast.className = `hud-toast is-${kind}`;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), ms);
}

/** "+5" cells behind the car ahead, or "+1L" once a whole lap or more behind. */
export function gapLabel(car: HudCar, ahead: HudCar | undefined, spineLen: number): string {
  if (!ahead) return "-";
  const gap = Math.max(0, ahead.progress - car.progress);
  return gap >= spineLen ? `+${Math.floor(gap / spineLen)}L` : `+${gap}`;
}

/** Lap column / card text: the lap the car is in, "Finished" once it crossed the line to end the race. */
function lapText(car: HudCar, raceLaps: number, short = false): string {
  if (car.finished) return short ? "Fin" : "Finished";
  return short ? `${car.lap}/${raceLaps}` : `Lap ${car.lap} / ${raceLaps}`;
}

export function bannerText(s: HudSnapshot): string {
  const winner = s.cars.find((c) => c.carId === s.winnerCarId);
  if (s.sandbox === "edit") return "Sandbox: editing - drag any car, E to play";
  if (s.finished) return `Race finished - ${winner ? winner.name : `Car ${s.winnerCarId}`} wins`;
  const active = s.cars.find((c) => c.carId === s.activeCarId);
  if (!active) return "";
  if (active.carId === s.myCarId && s.canControl && s.boxedIn) {
    if (s.pitExitBlocked) return `Pit exit blocked - squeeze out (+${SQUEEZE_SURCHARGE_PER_CAR} points per car)`;
    return `Boxed in - squeeze past (+${SQUEEZE_SURCHARGE_PER_CAR} points per car)`;
  }
  if (active.carId === s.myCarId) return s.canControl ? "Your turn - drag your car" : "Waiting for the server";
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
  const span = document.createElement("span");
  span.className = "hud-style";
  span.textContent = ` · ${car.style}`;
  const cell = document.createElement("span");
  cell.append(car.name, span);
  return cell;
}

function fillStandings(tbody: Element, cars: HudCar[], s: HudSnapshot, rowId: string) {
  tbody.replaceChildren(
    ...cars.map((car, i) => {
      const tr = document.createElement("tr");
      tr.dataset.testid = rowId;
      tr.dataset.carId = String(car.carId);
      tr.classList.toggle("is-me", car.carId === s.myCarId);
      tr.classList.toggle("is-active", !s.finished && car.carId === s.activeCarId);
      const chip = document.createElement("span");
      chip.className = "hud-chip";
      chip.style.background = car.color;
      const icon = car.state === "DNF" ? "DNF" : car.state === "PITTING" ? "PIT" : "";
      const cells: Array<string | HTMLElement> = [
        String(i + 1),
        chip,
        nameCell(car),
        lapText(car, s.raceLaps, true),
        gapLabel(car, cars[i - 1], s.spineLen),
        icon
      ];
      for (const content of cells) {
        const td = document.createElement("td");
        td.append(content);
        tr.append(td);
      }
      return tr;
    })
  );
}

export function renderHud(root: HTMLElement, s: HudSnapshot) {
  const me = s.cars.find((c) => c.carId === s.myCarId);
  const banner = q(root, "hud-banner");
  banner.textContent = bannerText(s);
  banner.className = `hud-banner${s.finished ? " is-finished" : s.canControl ? (s.boxedIn ? " is-mine is-boxed" : " is-mine") : ""}`;

  q(root, "hud-card").hidden = !me;
  if (me) {
    q(root, "hud-chip").style.background = me.color;
    q(root, "hud-name").textContent = me.name;
    q(root, "hud-lap").textContent = lapText(me, s.raceLaps);
    q(root, "hud-lap-hint").hidden = me.lap > 0 || me.finished;
    q(root, "hud-position").textContent = `P${s.cars.indexOf(me) + 1} / ${s.cars.length}`;
    setMeter(q(root, "hud-tire"), q(root, "hud-tire-bar"), "Tire", me.tire);
    setMeter(q(root, "hud-fuel"), q(root, "hud-fuel-bar"), "Fuel", me.fuel);
    const compound = q(root, "hud-compound");
    compound.textContent = me.compound.toUpperCase();
    compound.className = `hud-compound is-${me.compound}`;
    q(root, "hud-budget").textContent = `${me.remaining} / ${MOVE_CYCLE.budget}`;
    q(root, "hud-stint").textContent = formatStint(me.stint);
    const advice = q(root, "hud-advice");
    const label = ADVICE_LABEL[me.advice];
    advice.hidden = !label;
    advice.textContent = label ?? "";
    advice.className = `hud-advice is-${me.advice}`;
    const warning = q(root, "hud-warning");
    const warn = resourceWarning(me);
    warning.hidden = warn === null;
    warning.textContent = warn ?? "";
    q(root, "hud-pips").replaceChildren(
      ...me.cycle.map((spent, i) => {
        const pip = document.createElement("i");
        pip.dataset.testid = "hud-pip";
        pip.textContent = String(spent);
        pip.className = i === me.cycleIndex ? "is-current" : spent > 0 ? "is-used" : "";
        return pip;
      })
    );
    const state = q(root, "hud-state");
    state.hidden = me.state !== "PITTING" && me.state !== "DNF";
    state.textContent =
      me.state === "DNF" ? "DNF" : `PITTING ${me.pitTurns} turn${me.pitTurns === 1 ? "" : "s"}`;
  }

  fillStandings(q(root, "hud-standings").querySelector("tbody")!, s.cars, s, "hud-standing-row");

  const feed = q(root, "hud-feed-list");
  feed.replaceChildren(
    ...s.log.map((line) => {
      const li = document.createElement("li");
      li.textContent = line;
      return li;
    })
  );

  const tip = q(root, "hud-tooltip");
  tip.hidden = !s.hover;
  if (s.hover) {
    const h = s.hover;
    renderTooltip(tip, h);
    tip.style.left = `${h.x}px`;
    tip.style.top = `${h.y}px`;
  }
  const dbg = q(root, "hud-debug");
  dbg.hidden = s.debugText === null;
  dbg.textContent = s.debugText ?? "";
}

/** Final standings for the results overlay. */
export function renderResults(root: HTMLElement, s: HudSnapshot) {
  fillStandings(q(root, "results-standings").querySelector("tbody")!, s.cars, { ...s, finished: true }, "results-row");
}
