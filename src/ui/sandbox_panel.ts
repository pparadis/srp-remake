import type { Compound, WingLevel } from '../game/constants';
import { must } from '../game/must';
import type { CarEdit } from '../game/race/sandbox';
import type { BotLevel } from '../game/types/car';

// DOM panel of the sandbox (`?sandbox`). The scene sends `srp:sandbox` snapshots after every change; the panel sends
// `srp:sandbox-command` back. No Phaser here, same split as the HUD.

export interface SandboxSnapshot {
  editing: boolean;
  activeCarId: number;
  carIds: number[];
  car: {
    cellId: string;
    lapCount: number;
    tire: number;
    fuel: number;
    compound: Compound;
    wing: WingLevel;
    /** The fuel load of the setup; null on rules that have none (before v3), which hides the field. */
    fuelLoad: number | null;
    budgetLeft: number;
    draftTurns: number;
    isBot: boolean;
    botLevel: BotLevel;
  };
  /** Laps in the race: the lap field goes from -1 to this minus one. */
  raceLaps: number;
}

export type SandboxCommand =
  | { type: 'edit'; carId: number; edit: CarEdit }
  | { type: 'select'; carId: number }
  | { type: 'mode'; editing: boolean }
  | { type: 'copy-test' }
  | { type: 'copy-link' }
  | { type: 'load'; text: string };

const TEMPLATE = `
<div class="sandbox-head">
  <b>Sandbox</b>
  <button type="button" data-testid="sandbox-mode"></button>
</div>
<fieldset data-testid="sandbox-fields">
  <label>Car <select data-testid="sandbox-car"></select></label>
  <label>Cell <input data-testid="sandbox-cell" size="10" spellcheck="false" /></label>
  <label>Driver
    <select data-testid="sandbox-driver">
      <option value="human">Human</option><option value="easy">Bot easy</option>
      <option value="normal">Bot normal</option><option value="hard">Bot hard</option>
    </select>
  </label>
  <label>Lap done <input data-testid="sandbox-lap" type="number" step="1" /></label>
  <label>Tire % <input data-testid="sandbox-tire" type="number" min="0" max="100" /></label>
  <label>Fuel % <input data-testid="sandbox-fuel" type="number" min="0" max="100" /></label>
  <label>Moves left <input data-testid="sandbox-budget" type="number" min="0" max="42" /></label>
  <label>Draft turns <input data-testid="sandbox-draft" type="number" min="0" max="9" /></label>
  <label>Compound
    <select data-testid="sandbox-compound"><option value="soft">Soft</option><option value="medium">Medium</option><option value="hard">Hard</option></select>
  </label>
  <label data-testid="sandbox-fuel-load-field">Fuel load % <input data-testid="sandbox-fuel-load" type="number" min="40" max="100" step="5" /></label>
  <label>Wing
    <select data-testid="sandbox-wing"><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select>
  </label>
</fieldset>
<div class="sandbox-row">
  <button type="button" data-testid="sandbox-copy-test">Copy as test</button>
  <button type="button" data-testid="sandbox-copy-link">Copy link</button>
</div>
<details>
  <summary>Load position</summary>
  <textarea data-testid="sandbox-load-text" rows="4" placeholder="Paste a Copy debug snapshot"></textarea>
  <button type="button" data-testid="sandbox-load">Load</button>
</details>
<div class="sandbox-hint">E: edit/play &middot; drag any car &middot; click a car to make it play</div>
`;

function send(command: SandboxCommand): void {
  window.dispatchEvent(new CustomEvent<SandboxCommand>('srp:sandbox-command', { detail: command }));
}

export function mountSandboxPanel(parent: Element): HTMLElement {
  const root = document.createElement('section');
  root.className = 'hud-card sandbox-panel';
  root.dataset.testid = 'sandbox-panel';
  root.hidden = true; // until a race sends a snapshot: online races have no sandbox
  root.innerHTML = TEMPLATE;
  parent.append(root);
  const q = <T extends HTMLElement>(id: string) =>
    must(root.querySelector<T>(`[data-testid="${id}"]`), `sandbox element ${id}`);
  let last: SandboxSnapshot | null = null;
  const carId = () => last?.activeCarId ?? 0;
  const edit = (patch: CarEdit) => send({ type: 'edit', carId: carId(), edit: patch });
  const num = (
    id: string,
    key: 'lapCount' | 'tire' | 'fuel' | 'budgetLeft' | 'draftTurns' | 'fuelLoad'
  ) =>
    q<HTMLInputElement>(id).addEventListener('change', (e) => {
      const value = (e.target as HTMLInputElement).valueAsNumber;
      if (Number.isFinite(value)) edit({ [key]: value });
    });
  num('sandbox-lap', 'lapCount');
  num('sandbox-tire', 'tire');
  num('sandbox-fuel', 'fuel');
  num('sandbox-fuel-load', 'fuelLoad');
  num('sandbox-budget', 'budgetLeft');
  num('sandbox-draft', 'draftTurns');
  q('sandbox-car').addEventListener('change', (e) =>
    send({ type: 'select', carId: Number((e.target as HTMLSelectElement).value) })
  );
  q('sandbox-cell').addEventListener('change', (e) =>
    edit({ cellId: (e.target as HTMLInputElement).value.trim() })
  );
  q('sandbox-compound').addEventListener('change', (e) =>
    edit({ compound: (e.target as HTMLSelectElement).value as Compound })
  );
  q('sandbox-wing').addEventListener('change', (e) =>
    edit({ wing: (e.target as HTMLSelectElement).value as WingLevel })
  );
  q('sandbox-driver').addEventListener('change', (e) => {
    const value = (e.target as HTMLSelectElement).value;
    edit(value === 'human' ? { isBot: false } : { isBot: true, botLevel: value as BotLevel });
  });
  q('sandbox-mode').addEventListener('click', () =>
    send({ type: 'mode', editing: !last?.editing })
  );
  q('sandbox-copy-test').addEventListener('click', () => send({ type: 'copy-test' }));
  q('sandbox-copy-link').addEventListener('click', () => send({ type: 'copy-link' }));
  q('sandbox-load').addEventListener('click', () =>
    send({ type: 'load', text: q<HTMLTextAreaElement>('sandbox-load-text').value })
  );
  window.addEventListener('srp:sandbox', (event) => {
    last = (event as CustomEvent<SandboxSnapshot>).detail;
    root.hidden = false;
    renderSandboxPanel(root, last);
  });
  return root;
}

// A field being typed in keeps its text: only the others follow the snapshot.
function setValue(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  if (document.activeElement !== input) input.value = value;
}

export function renderSandboxPanel(root: HTMLElement, s: SandboxSnapshot) {
  const q = <T extends HTMLElement>(id: string) =>
    must(root.querySelector<T>(`[data-testid="${id}"]`), `sandbox element ${id}`);
  q<HTMLButtonElement>('sandbox-mode').textContent = s.editing ? 'Play (E)' : 'Edit (E)';
  q<HTMLFieldSetElement>('sandbox-fields').disabled = !s.editing;
  const select = q<HTMLSelectElement>('sandbox-car');
  if (select.options.length !== s.carIds.length) {
    select.replaceChildren(
      ...s.carIds.map((id) =>
        Object.assign(document.createElement('option'), {
          value: String(id),
          textContent: `Car ${id}`
        })
      )
    );
  }
  setValue(select, String(s.activeCarId));
  setValue(q<HTMLInputElement>('sandbox-cell'), s.car.cellId);
  setValue(q<HTMLSelectElement>('sandbox-driver'), s.car.isBot ? s.car.botLevel : 'human');
  const lap = q<HTMLInputElement>('sandbox-lap');
  lap.min = '-1';
  lap.max = String(s.raceLaps - 1);
  setValue(lap, String(s.car.lapCount));
  setValue(q<HTMLInputElement>('sandbox-tire'), String(Math.round(s.car.tire)));
  setValue(q<HTMLInputElement>('sandbox-fuel'), String(Math.round(s.car.fuel)));
  setValue(q<HTMLInputElement>('sandbox-budget'), String(s.car.budgetLeft));
  setValue(q<HTMLInputElement>('sandbox-draft'), String(s.car.draftTurns));
  setValue(q<HTMLSelectElement>('sandbox-compound'), s.car.compound);
  setValue(q<HTMLSelectElement>('sandbox-wing'), s.car.wing);
  q('sandbox-fuel-load-field').hidden = s.car.fuelLoad === null;
  setValue(q<HTMLInputElement>('sandbox-fuel-load'), String(s.car.fuelLoad ?? ''));
}
