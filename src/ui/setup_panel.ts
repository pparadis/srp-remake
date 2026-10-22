import { COMPOUNDS, type Compound } from '../game/constants';
import { must } from '../game/must';
import {
  fitToFeatures,
  nudgeFuel,
  nudgePsi,
  nudgeWing,
  type SetupFeatures
} from '../game/systems/setup_edit';
import type { StintEstimate } from '../game/systems/strategy';
import type { Car } from '../game/types/car';
import { formatStint } from './hud';

// The grid setup menu (compound, pressures, wing, fuel load): DOM, so the text is the page's own and the panel scrolls on
// a short screen instead of fighting the HUD for room. No Phaser here, same split as the HUD; the scene calls
// `open` and gets the edited setup back through `onConfirm`. (The pit stop still uses the canvas `PitModal`.)

export interface SetupPanelOptions {
  setup: Car['setup'];
  /** Estimated stint on fresh tires and fuel for each compound at the setup being edited. */
  stints: (setup: Car['setup']) => Record<Compound, StintEstimate>;
  /** The cycle budget the setup being edited buys. */
  pace: (setup: Car['setup']) => number;
  features: SetupFeatures;
  /** The line under the fuel row: what the load being edited buys (rules v3 only). */
  fuelNote: (setup: Car['setup']) => string;
  /** The setup the bots would pick; the Suggested button shows when given. */
  suggest?: () => Car['setup'];
  onConfirm: (setup: Car['setup']) => void;
  onCancel: () => void;
}

const COMPOUND_LABEL: Record<Compound, string> = { hard: 'Hard', medium: 'Med', soft: 'Soft' };

function stepper(id: string, label: string): string {
  return `
  <span class="setup-step">
    <button type="button" data-testid="setup-${id}-minus" aria-label="Lower ${label}">-</button>
    <button type="button" data-testid="setup-${id}-plus" aria-label="Raise ${label}">+</button>
  </span>`;
}

const TEMPLATE = `
<section class="setup-card" role="dialog" aria-labelledby="setup-title">
  <h2 id="setup-title">Grid setup</h2>
  <div class="setup-controls">
  <div class="setup-row">
    <span>Compound</span>
    <span class="setup-compounds">${COMPOUNDS.map(
      (c) => `<button type="button" data-testid="setup-compound-${c}">${COMPOUND_LABEL[c]}</button>`
    ).join('')}</span>
  </div>
  <div class="setup-row"><span>PSI FL/FR/RL/RR</span><b data-testid="setup-psi"></b>${stepper('psi', 'pressure')}</div>
  <div class="setup-row"><span>Wing</span><b data-testid="setup-wing"></b>${stepper('wing', 'wing')}</div>
  <div class="setup-row" data-testid="setup-fuel-row"><span>Fuel load</span><b data-testid="setup-fuel"></b>${stepper('fuel', 'fuel load')}</div>
  <p class="setup-note" data-testid="setup-fuel-note"></p>
  </div>
  <div class="setup-stints">
    <span>Stint on fresh tires and fuel</span>
    ${COMPOUNDS.map((c) => `<div data-testid="setup-stint-${c}"></div>`).join('')}
  </div>
  <div class="setup-actions">
    <button type="button" data-testid="setup-confirm">Confirm</button>
    <button type="button" data-testid="setup-suggest">Suggested</button>
    <button type="button" data-testid="setup-cancel">Cancel</button>
  </div>
</section>
`;

export class SetupPanel {
  private readonly root: HTMLElement;
  private setup: Car['setup'] | null = null;
  private options: SetupPanelOptions | null = null;

  constructor(parent: Element) {
    this.root = document.createElement('div');
    this.root.className = 'setup-panel';
    this.root.dataset.testid = 'setup-panel';
    this.root.hidden = true;
    this.root.innerHTML = TEMPLATE;
    parent.append(this.root);

    for (const c of COMPOUNDS) {
      this.q(`setup-compound-${c}`).addEventListener('click', () =>
        this.edit((s) => (s.compound = c))
      );
    }
    const step = (
      id: string,
      minus: (s: Car['setup']) => void,
      plus: (s: Car['setup']) => void
    ) => {
      this.q(`setup-${id}-minus`).addEventListener('click', () => this.edit(minus));
      this.q(`setup-${id}-plus`).addEventListener('click', () => this.edit(plus));
    };
    step(
      'psi',
      (s) => nudgePsi(s, -1),
      (s) => nudgePsi(s, 1)
    );
    step(
      'wing',
      (s) => nudgeWing(s, -1),
      (s) => nudgeWing(s, 1)
    );
    step(
      'fuel',
      (s) => nudgeFuel(s, -1),
      (s) => nudgeFuel(s, 1)
    );
    this.q('setup-suggest').addEventListener('click', () => {
      const suggested = this.options?.suggest?.();
      if (!suggested || !this.options) return;
      this.setup = fitToFeatures(suggested, this.options.features);
      this.render();
    });
    this.q('setup-confirm').addEventListener('click', () => {
      if (this.options && this.setup) this.options.onConfirm(this.setup);
    });
    this.q('setup-cancel').addEventListener('click', () => this.options?.onCancel());
    window.addEventListener('keydown', this.onKeyDown);
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && this.isActive()) this.options?.onCancel();
  };

  /** Removes the panel and its key listener (the scene that made it is shutting down). */
  destroy(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    this.root.remove();
  }

  isActive(): boolean {
    return !this.root.hidden;
  }

  open(options: SetupPanelOptions): void {
    this.options = options;
    this.setup = fitToFeatures(options.setup, options.features);
    this.q('setup-fuel-row').hidden = !options.features.fuelLoad;
    this.q('setup-fuel-note').hidden = !options.features.fuelLoad;
    this.q('setup-compound-medium').hidden = !options.features.medium;
    this.q('setup-stint-medium').hidden = !options.features.medium;
    this.q('setup-suggest').hidden = options.suggest === undefined;
    this.root.hidden = false;
    this.render();
    this.q('setup-confirm').focus();
  }

  close(): void {
    this.root.hidden = true;
    this.setup = null;
    this.options = null;
  }

  private q(id: string): HTMLElement {
    return must(
      this.root.querySelector<HTMLElement>(`[data-testid="${id}"]`),
      `setup element ${id}`
    );
  }

  private edit(change: (setup: Car['setup']) => void): void {
    if (!this.setup || !this.options) return;
    change(this.setup);
    // the fuel row is hidden without a fuel load, and its buttons must not change the setup then
    if (!this.options.features.fuelLoad) delete this.setup.fuelLoad;
    this.render();
  }

  private render(): void {
    const { setup, options } = this;
    if (!setup || !options) return;
    for (const c of COMPOUNDS) {
      this.q(`setup-compound-${c}`).classList.toggle('is-chosen', setup.compound === c);
    }
    const psi = setup.psi;
    this.q('setup-psi').textContent = `${psi.fl}/${psi.fr}/${psi.rl}/${psi.rr}`;
    // The cycle budget is what the wing and the compound buy in pace; the wear shows in the stint lines below.
    this.q('setup-wing').textContent = `${setup.wing} (pace ${options.pace(setup)})`;
    if (options.features.fuelLoad) {
      this.q('setup-fuel').textContent = `${setup.fuelLoad ?? 100}%`;
      this.q('setup-fuel-note').textContent = options.fuelNote(setup);
    }
    const stints = options.stints(setup);
    for (const c of COMPOUNDS) {
      const line = this.q(`setup-stint-${c}`);
      line.textContent = `${setup.compound === c ? '>' : ' '} ${c.padEnd(6)} ${formatStint(stints[c])}`;
      line.classList.toggle('is-chosen', setup.compound === c);
    }
  }
}
