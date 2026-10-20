import { textResolution } from '../../hidpi';
import { must } from '../../must';
import type Phaser from 'phaser';
import type { Car } from '../../types/car';
import { SETUP_LIMITS, WING_LEVELS } from '../../constants';
import { cycleBudget } from '../../systems/move_budget_system';
import { formatStint } from '../../../ui/hud';
import type { StintEstimate } from '../../systems/strategy';
import { makeButton } from './make_button';
import { pinToScreen } from './pin_to_screen';

export interface PitStints {
  soft: StintEstimate;
  hard: StintEstimate;
}

interface PitModalTexts {
  compound: Phaser.GameObjects.Text;
  psi: Phaser.GameObjects.Text;
  wing: Phaser.GameObjects.Text;
  stintSoft: Phaser.GameObjects.Text;
  stintHard: Phaser.GameObjects.Text;
}

interface PitModalOpenOptions {
  /** Heading of the panel; "Pit stop" when omitted (the grid setup reuses the panel). */
  title?: string;
  setup: Car['setup'];
  bodyLines: string[];
  /** Estimated stint on fresh tires and fuel for each compound at the setup being edited. */
  stints: (setup: Car['setup']) => PitStints;
  onConfirm: (setup: Car['setup']) => void;
  onCancel: () => void;
}

/** The panel, in the modal's own coordinates; the scene centres and scales the modal from it. */
export const PIT_PANEL = { x: 320, y: 200, width: 460, height: 345 };

export class PitModal {
  private readonly scene: Phaser.Scene;
  private readonly modal: Phaser.GameObjects.Container;
  private readonly modalTitle: Phaser.GameObjects.Text;
  private readonly modalBody: Phaser.GameObjects.Text;
  private readonly modalConfirm: Phaser.GameObjects.Text;
  private readonly wingButtons!: { minus: Phaser.GameObjects.Text; plus: Phaser.GameObjects.Text };
  private readonly modalCancel: Phaser.GameObjects.Text;
  private modalSetup: Car['setup'] | null = null;
  private stints: PitModalOpenOptions['stints'] | null = null;
  private readonly modalValueTexts: PitModalTexts;
  private active = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;

    const panel = this.scene.add.graphics();
    panel.fillStyle(0x0f141b, 0.98);
    const { x, y, width, height } = PIT_PANEL;
    panel.fillRoundedRect(x, y, width, height, 10);
    panel.lineStyle(1, 0x2a3642, 1);
    panel.strokeRoundedRect(x, y, width, height, 10);

    this.modalTitle = this.scene.add.text(350, 220, 'Pit stop', {
      fontFamily: 'monospace',
      resolution: textResolution(),
      fontSize: '18px',
      color: '#e6edf3'
    });
    this.modalBody = this.scene.add.text(350, 255, '', {
      fontFamily: 'monospace',
      resolution: textResolution(),
      fontSize: '13px',
      color: '#c7d1db',
      lineSpacing: 4,
      wordWrap: { width: 400 }
    });

    const fieldY = 342;
    const lineH = 26;
    const labelX = 350;
    const valueX = 470;
    const controlX = 620;

    const compoundLabel = this.scene.add.text(labelX, fieldY, 'Compound', {
      fontFamily: 'monospace',
      resolution: textResolution(),
      fontSize: '13px',
      color: '#9fb0bf'
    });
    const compoundValue = this.scene.add.text(valueX, fieldY, '', {
      fontFamily: 'monospace',
      resolution: textResolution(),
      fontSize: '13px',
      color: '#e6edf3'
    });
    const compoundToggle = this.createModalButton(controlX, fieldY - 6, 'Toggle');
    compoundToggle.setScale(0.85);
    compoundToggle.on('pointerdown', () => {
      if (!this.modalSetup) return;
      this.modalSetup.compound = this.modalSetup.compound === 'soft' ? 'hard' : 'soft';
      this.refreshModalValues();
    });

    const psiLabel = this.scene.add.text(labelX, fieldY + lineH, 'PSI FL/FR/RL/RR', {
      fontFamily: 'monospace',
      resolution: textResolution(),
      fontSize: '13px',
      color: '#9fb0bf'
    });
    const psiValue = this.scene.add.text(labelX, fieldY + lineH + 12, '', {
      fontFamily: 'monospace',
      resolution: textResolution(),
      fontSize: '13px',
      color: '#e6edf3'
    });
    const psiMinus = this.createModalButton(controlX, fieldY + lineH + 8, '-');
    const psiPlus = this.createModalButton(controlX + 40, fieldY + lineH + 8, '+');
    psiMinus.setScale(0.85);
    psiPlus.setScale(0.85);
    psiMinus.on('pointerdown', () => this.adjustPsi(-1));
    psiPlus.on('pointerdown', () => this.adjustPsi(1));

    const wingLabel = this.scene.add.text(labelX, fieldY + lineH * 2 + 16, 'Wing', {
      fontFamily: 'monospace',
      resolution: textResolution(),
      fontSize: '13px',
      color: '#9fb0bf'
    });
    const wingValue = this.scene.add.text(valueX, fieldY + lineH * 2 + 16, '', {
      fontFamily: 'monospace',
      resolution: textResolution(),
      fontSize: '13px',
      color: '#e6edf3'
    });
    const wingMinus = this.createModalButton(controlX, fieldY + lineH * 2 + 12, '-');
    const wingPlus = this.createModalButton(controlX + 40, fieldY + lineH * 2 + 12, '+');
    wingMinus.setScale(0.85);
    wingPlus.setScale(0.85);
    wingMinus.on('pointerdown', () => this.adjustWing(-1));
    wingPlus.on('pointerdown', () => this.adjustWing(1));
    this.wingButtons = { minus: wingMinus, plus: wingPlus };

    const stintTitle = this.scene.add.text(
      labelX,
      fieldY + lineH * 3 + 14,
      'Stint on fresh tires and fuel',
      {
        fontFamily: 'monospace',
        resolution: textResolution(),
        fontSize: '13px',
        color: '#9fb0bf'
      }
    );
    const stintStyle = {
      fontFamily: 'monospace',
      resolution: textResolution(),
      fontSize: '13px',
      color: '#e6edf3'
    };
    const stintSoft = this.scene.add.text(labelX, fieldY + lineH * 3 + 34, '', stintStyle);
    const stintHard = this.scene.add.text(labelX, fieldY + lineH * 3 + 54, '', stintStyle);

    this.modalValueTexts = {
      compound: compoundValue,
      psi: psiValue,
      wing: wingValue,
      stintSoft,
      stintHard
    };

    this.modalConfirm = this.createModalButton(360, 502, 'Confirm');
    this.modalCancel = this.createModalButton(520, 502, 'Cancel');

    this.modal = this.scene.add.container(0, 0, [
      panel,
      this.modalTitle,
      this.modalBody,
      compoundLabel,
      compoundValue,
      compoundToggle,
      psiLabel,
      psiValue,
      psiMinus,
      psiPlus,
      wingLabel,
      wingValue,
      wingMinus,
      wingPlus,
      stintTitle,
      stintSoft,
      stintHard,
      this.modalConfirm,
      this.modalCancel
    ]);
    this.modal.setDepth(100);
    this.modal.setVisible(false);
  }

  isActive() {
    return this.active;
  }

  /** The buttons an e2e test presses with the real mouse (see `window.__srp.uiButtonPos`). */
  button(name: 'wing-minus' | 'wing-plus' | 'confirm'): Phaser.GameObjects.Text {
    return name === 'confirm'
      ? this.modalConfirm
      : name === 'wing-minus'
        ? this.wingButtons.minus
        : this.wingButtons.plus;
  }

  open(options: PitModalOpenOptions) {
    this.modalSetup = structuredClone(options.setup);
    this.stints = options.stints;
    this.modalTitle.setText(options.title ?? 'Pit stop');
    this.modalBody.setText(options.bodyLines.join('\n'));
    this.refreshModalValues();
    this.modal.setVisible(true);
    this.active = true;

    this.modalConfirm.removeAllListeners('pointerdown');
    this.modalCancel.removeAllListeners('pointerdown');

    this.modalConfirm.once('pointerdown', () => {
      if (!this.modalSetup) return;
      options.onConfirm(this.modalSetup);
    });

    this.modalCancel.once('pointerdown', () => {
      options.onCancel();
    });
  }

  close() {
    this.modalSetup = null;
    this.modal.setVisible(false);
    this.active = false;
  }

  getContainer() {
    return this.modal;
  }

  setFixed() {
    pinToScreen(this.modal);
    for (const child of this.modal.list) pinToScreen(child);
  }

  private createModalButton(x: number, y: number, label: string): Phaser.GameObjects.Text {
    return makeButton(this.scene, label, { fontSize: '14px' }).setPosition(x, y);
  }

  private refreshModalValues() {
    if (!this.modalSetup) return;
    this.modalValueTexts.compound.setText(this.modalSetup.compound);
    this.modalValueTexts.psi.setText(
      `${this.modalSetup.psi.fl}/${this.modalSetup.psi.fr}/${this.modalSetup.psi.rl}/${this.modalSetup.psi.rr}`
    );
    // The cycle budget is what the wing and the compound buy in pace; the wear shows in the stint lines below.
    this.modalValueTexts.wing.setText(
      `${this.modalSetup.wing}  (pace ${cycleBudget(this.modalSetup)})`
    );
    if (!this.stints) return;
    const stints = this.stints(this.modalSetup);
    for (const compound of ['soft', 'hard'] as const) {
      const chosen = this.modalSetup.compound === compound;
      const text = this.modalValueTexts[compound === 'soft' ? 'stintSoft' : 'stintHard'];
      text.setText(`${chosen ? '>' : ' '} ${compound.padEnd(4)} ${formatStint(stints[compound])}`);
      text.setColor(chosen ? '#ffe066' : '#9fb0bf');
    }
  }

  private adjustPsi(delta: number) {
    if (!this.modalSetup) return;
    const clamp = (v: number) =>
      Math.max(SETUP_LIMITS.psi.min, Math.min(SETUP_LIMITS.psi.max, v + delta));
    this.modalSetup.psi.fl = clamp(this.modalSetup.psi.fl);
    this.modalSetup.psi.fr = clamp(this.modalSetup.psi.fr);
    this.modalSetup.psi.rl = clamp(this.modalSetup.psi.rl);
    this.modalSetup.psi.rr = clamp(this.modalSetup.psi.rr);
    this.refreshModalValues();
  }

  // "-" is a lower wing (faster, wears more), "+" a higher one (slower, saves tires and fuel).
  private adjustWing(delta: number) {
    if (!this.modalSetup) return;
    const index = WING_LEVELS.indexOf(this.modalSetup.wing) + delta;
    this.modalSetup.wing = must(
      WING_LEVELS[Math.max(0, Math.min(WING_LEVELS.length - 1, index))],
      'wing level'
    );
    this.refreshModalValues();
  }
}
