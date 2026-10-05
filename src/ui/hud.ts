// Race HUD as a DOM overlay. `renderHud` is pure over the snapshot RaceScene emits as `srp:hud`.

export interface HudCar {
  carId: number;
  name: string;
  /** CSS colour of the car sprite. */
  color: string;
  isBot: boolean;
  lap: number;
  /** forwardIndex of the cell the car stands on (lower is further ahead on the same lap). */
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
}

export interface HudSnapshot {
  raceLaps: number;
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
    <div class="hud-pos" data-testid="hud-position"></div>
    <div class="hud-meter"><span data-testid="hud-tire"></span><span class="hud-compound" data-testid="hud-compound"></span>
      <div class="hud-bar"><i data-testid="hud-tire-bar"></i></div></div>
    <div class="hud-meter"><span data-testid="hud-fuel"></span>
      <div class="hud-bar"><i data-testid="hud-fuel-bar"></i></div></div>
    <div class="hud-meter"><span>Moves</span><span data-testid="hud-budget"></span>
      <div class="hud-pips" data-testid="hud-pips"></div></div>
  </section>
  <div class="hud-hint" data-testid="hud-hint">F: fwd overlay &middot; C: cars+moves</div>
</div>
<div class="hud-right">
  <table class="hud-standings" data-testid="hud-standings">${HEAD}<tbody></tbody></table>
  <details class="hud-feed" data-testid="hud-feed"><summary>Race feed</summary><ol data-testid="hud-feed-list"></ol></details>
</div>
<div class="hud-tooltip" data-testid="hud-tooltip" hidden></div>
<pre class="hud-debug" data-testid="hud-debug" hidden></pre>
`;

export function mountHud(root: HTMLElement) {
  root.innerHTML = TEMPLATE;
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

export function gapLabel(car: HudCar, ahead: HudCar | undefined): string {
  if (!ahead) return "-";
  if (car.lap !== ahead.lap) return `+${Math.abs(ahead.lap - car.lap)}L`;
  return `+${Math.max(0, car.fwd - ahead.fwd)}`;
}

export function bannerText(s: HudSnapshot): string {
  const winner = s.cars.find((c) => c.carId === s.winnerCarId);
  if (s.finished) return `Race finished - ${winner ? winner.name : `Car ${s.winnerCarId}`} wins`;
  const active = s.cars.find((c) => c.carId === s.activeCarId);
  if (!active) return "";
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
        car.name,
        `${car.lap}/${s.raceLaps}`,
        gapLabel(car, cars[i - 1]),
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
  banner.className = `hud-banner${s.finished ? " is-finished" : s.canControl ? " is-mine" : ""}`;

  q(root, "hud-card").hidden = !me;
  if (me) {
    q(root, "hud-chip").style.background = me.color;
    q(root, "hud-name").textContent = me.name;
    q(root, "hud-lap").textContent = `Lap ${me.lap} / ${s.raceLaps}`;
    q(root, "hud-position").textContent = `P${s.cars.indexOf(me) + 1} / ${s.cars.length}`;
    setMeter(q(root, "hud-tire"), q(root, "hud-tire-bar"), "Tire", me.tire);
    setMeter(q(root, "hud-fuel"), q(root, "hud-fuel-bar"), "Fuel", me.fuel);
    const compound = q(root, "hud-compound");
    compound.textContent = me.compound.toUpperCase();
    compound.className = `hud-compound is-${me.compound}`;
    q(root, "hud-budget").textContent = `${me.remaining} / 40`;
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
    tip.textContent = `Move ${h.moveSpend} - tire -${h.tireCost} - fuel -${h.fuelCost}${h.isPit ? " - PIT" : ""}`;
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
