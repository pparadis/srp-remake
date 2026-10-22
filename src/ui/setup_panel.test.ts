/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarSetup } from '../game/types/car';
import { SetupPanel, type SetupPanelOptions } from './setup_panel';

const SETUP: CarSetup = {
  compound: 'medium',
  fuelLoad: 95,
  psi: { fl: 22, fr: 22, rl: 22, rr: 22 },
  wing: 'medium'
};

const el = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`)!;
const click = (id: string) => el(id).click();

function open(panel: SetupPanel, extra: Partial<SetupPanelOptions> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  panel.open({
    setup: SETUP,
    stints: () => ({
      hard: { cells: 100, laps: 6.1, moves: 25 },
      medium: { cells: 80, laps: 4.8, moves: 18 },
      soft: { cells: 70, laps: 4.3, moves: 15 }
    }),
    pace: (s) => (s.wing === 'low' ? 41 : 38),
    features: { medium: true, fuelLoad: true, psi: true },
    fuelNote: (s) => `load ${s.fuelLoad}`,
    onConfirm,
    onCancel,
    ...extra
  });
  return { onConfirm, onCancel };
}

describe('SetupPanel', () => {
  let panel: SetupPanel;
  beforeEach(() => {
    document.body.replaceChildren();
    panel = new SetupPanel(document.body);
  });

  it('is hidden until opened, and shows the setup it is given', () => {
    expect(panel.isActive()).toBe(false);
    open(panel);
    expect(panel.isActive()).toBe(true);
    expect(el('setup-psi').textContent).toBe('22/22/22/22');
    expect(el('setup-wing').textContent).toBe('medium (pace 38)');
    expect(el('setup-fuel').textContent).toBe('95%');
    expect(el('setup-stint-medium').textContent).toContain('> medium');
    expect(el('setup-stint-medium').textContent).toContain('4.8 laps');
  });

  it('edits a copy and hands it back on Confirm, leaving the original alone', () => {
    const { onConfirm } = open(panel);
    click('setup-compound-soft');
    click('setup-wing-minus');
    click('setup-fuel-minus');
    click('setup-psi-plus');
    expect(el('setup-wing').textContent).toBe('low (pace 41)');
    expect(el('setup-fuel').textContent).toBe('90%');
    click('setup-confirm');
    expect(onConfirm).toHaveBeenCalledWith({
      compound: 'soft',
      fuelLoad: 90,
      psi: { fl: 23, fr: 23, rl: 23, rr: 23 },
      wing: 'low'
    });
    expect(SETUP.wing).toBe('medium');
  });

  it('Suggested fills in the bots pick; Cancel and Escape call back without a setup', () => {
    const suggested: CarSetup = { ...SETUP, compound: 'hard', wing: 'high', fuelLoad: 60 };
    const { onConfirm, onCancel } = open(panel, { suggest: () => suggested });
    click('setup-suggest');
    expect(el('setup-fuel').textContent).toBe('60%');
    click('setup-cancel');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('hides what the rules do not offer: no medium, no fuel row, no Suggested', () => {
    open(panel, { features: { medium: false, fuelLoad: false, psi: false } });
    expect(el('setup-psi-row').hidden).toBe(true);
    expect(el('setup-compound-medium').hidden).toBe(true);
    expect(el('setup-stint-medium').hidden).toBe(true);
    expect(el('setup-fuel-row').hidden).toBe(true);
    expect(el('setup-suggest').hidden).toBe(true);
  });

  it('close hides it, and destroy removes it', () => {
    open(panel);
    panel.close();
    expect(panel.isActive()).toBe(false);
    panel.destroy();
    expect(document.querySelector('[data-testid="setup-panel"]')).toBeNull();
  });
});
