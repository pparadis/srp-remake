import { textResolution } from '../../hidpi';
import { UI_FONT } from '../../ui_font';
import { must } from '../../must';
import type Phaser from 'phaser';
import type { Car } from '../../types/car';
import {
  COMPOUNDS,
  FUEL_LOAD_MIN,
  FUEL_LOAD_STEP,
  SETUP_LIMITS,
  WING_LEVELS,
  type Compound
} from '../../constants';
import { formatStint } from '../../../ui/hud';
import type { StintEstimate } from '../../systems/strategy';
import { makeButton } from './make_button';
import { pinToScreen } from './pin_to_screen';

export type PitStints = Record<Compound, StintEstimate>;

/** Buttons the e2e specs press with the real mouse (`window.__srp.uiButtonPos`). */
export type PitModalButton =
  | 'wing-minus'
  | 'wing-plus'
  | 'fuel-minus'
  | 'fuel-plus'
  | 'compound-hard'
  | 'compound-medium'
  | 'compound-soft'
  | 'suggest'
  | 'confirm';

interface PitModalTexts {
  psi: Phaser.GameObjects.Text;
  wing: Phaser.GameObjects.Text;
  fuel: Phaser.GameObjects.Text;
  fuelNote: Phaser.GameObjects.Text;
  stints: Record<Compound, Phaser.GameObjects.Text>;
}

interface PitModalOpenOptions {
  /** Heading of the panel; "Pit stop" when omitted (the grid setup reuses the panel). */
  title?: string;
  setup: Car['setup'];
  bodyLines: string[];
  /** Estimated stint on fresh tires and fuel for each compound at the setup being edited. */
  stints: (setup: Car['setup']) => PitStints;
  /** The cycle budget the setup being edited buys. */
  pace: (setup: Car['setup']) => number;
  /** What the rules offer: the medium compound and the fuel load row (rules v3). */
  features: { medium: boolean; fuelLoad: boolean };
  /** The line under the fuel row: what the load being edited buys (rules v3 only). */
  fuelNote: (setup: Car['setup']) => string;
  /** The setup the bots would pick; the Suggested button shows when given. */
  suggest?: () => Car['setup'];
  onConfirm: (setup: Car['setup']) => void;
  onCancel: () => void;
}

// Rows of the panel, top to bottom (the panel starts at PIT_PANEL.y). Without the fuel row everything below it moves
// up, and without the medium compound the stint list is one line shorter.
const ROW = {
  compound: 336,
  psi: 362,
  wing: 404,
  fuel: 432,
  fuelNote: 462,
  stintTitle: 488,
  stint: 506,
  stintStep: 18,
  buttons: 568
};
const FUEL_ROWS_HEIGHT = 56;
const FULL_HEIGHT = 405;

/** The panel, in the modal's own coordinates; the scene centres and scales the modal from it. */
export const PIT_PANEL = { x: 320, y: 200, width: 460, height: FULL_HEIGHT };

const CHOSEN = '#ffe066';
const BUTTON = '#c7d1db';

export class PitModal {
  private readonly scene: Phaser.Scene;
  private readonly modal: Phaser.GameObjects.Container;
  private readonly panel: Phaser.GameObjects.Graphics;
  private readonly modalTitle: Phaser.GameObjects.Text;
  private readonly modalBody: Phaser.GameObjects.Text;
  private readonly modalConfirm: Phaser.GameObjects.Text;
  private readonly modalCancel: Phaser.GameObjects.Text;
  private readonly suggestButton: Phaser.GameObjects.Text;
  private readonly compoundButtons: Record<Compound, Phaser.GameObjects.Text>;
  private readonly wingButtons: { minus: Phaser.GameObjects.Text; plus: Phaser.GameObjects.Text };
  private readonly fuelButtons: { minus: Phaser.GameObjects.Text; plus: Phaser.GameObjects.Text };
  /** Everything the fuel row owns, and the stint block and buttons that move with the layout. */
  private readonly fuelRow: Phaser.GameObjects.Text[];
  private readonly lower: Array<{ item: Phaser.GameObjects.Text; row: number }>;
  private modalSetup: Car['setup'] | null = null;
  private stints: PitModalOpenOptions['stints'] | null = null;
  private pace: PitModalOpenOptions['pace'] | null = null;
  private fuelNote: PitModalOpenOptions['fuelNote'] | null = null;
  private features: PitModalOpenOptions['features'] = { medium: false, fuelLoad: false };
  private readonly modalValueTexts: PitModalTexts;
  private active = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;

    this.panel = this.scene.add.graphics();
    this.drawPanel(FULL_HEIGHT);

    const text = (x: number, y: number, size = '13px', color = '#9fb0bf') =>
      this.scene.add.text(x, y, '', {
        fontFamily: UI_FONT,
        resolution: textResolution(),
        fontSize: size,
        color
      });
    const label = (x: number, y: number, content: string) => text(x, y).setText(content);

    this.modalTitle = text(350, 220, '18px', '#e6edf3').setText('Pit stop');
    this.modalBody = text(350, 255, '13px', '#c7d1db').setLineSpacing(4).setWordWrapWidth(400);

    const labelX = 350;
    const valueX = 470;
    const controlX = 620;

    const compoundLabel = label(labelX, ROW.compound, 'Compound');
    const compoundButton = (compound: Compound, x: number, caption: string) => {
      const button = this.createModalButton(x, ROW.compound - 6, caption).setScale(0.85);
      button.on('pointerdown', () => {
        if (!this.modalSetup) return;
        this.modalSetup.compound = compound;
        this.refreshModalValues();
      });
      // makeButton recolours on hover; the chosen one keeps its colour
      button.on('pointerover', () => this.refreshModalValues());
      button.on('pointerout', () => this.refreshModalValues());
      return button;
    };
    this.compoundButtons = {
      hard: compoundButton('hard', valueX, 'Hard'),
      medium: compoundButton('medium', valueX + 62, 'Med'),
      soft: compoundButton('soft', valueX + 112, 'Soft')
    };

    const psiLabel = label(labelX, ROW.psi, 'PSI FL/FR/RL/RR');
    const psiValue = text(labelX, ROW.psi + 12, '13px', '#e6edf3');
    const psiMinus = this.createModalButton(controlX, ROW.psi + 8, '-').setScale(0.85);
    const psiPlus = this.createModalButton(controlX + 40, ROW.psi + 8, '+').setScale(0.85);
    psiMinus.on('pointerdown', () => this.adjustPsi(-1));
    psiPlus.on('pointerdown', () => this.adjustPsi(1));

    const wingLabel = label(labelX, ROW.wing + 4, 'Wing');
    const wingValue = text(valueX, ROW.wing + 4, '13px', '#e6edf3');
    const wingMinus = this.createModalButton(controlX, ROW.wing, '-').setScale(0.85);
    const wingPlus = this.createModalButton(controlX + 40, ROW.wing, '+').setScale(0.85);
    wingMinus.on('pointerdown', () => this.adjustWing(-1));
    wingPlus.on('pointerdown', () => this.adjustWing(1));
    this.wingButtons = { minus: wingMinus, plus: wingPlus };

    const fuelLabel = label(labelX, ROW.fuel + 4, 'Fuel load');
    const fuelValue = text(valueX, ROW.fuel + 4, '13px', '#e6edf3');
    const fuelMinus = this.createModalButton(controlX, ROW.fuel, '-').setScale(0.85);
    const fuelPlus = this.createModalButton(controlX + 40, ROW.fuel, '+').setScale(0.85);
    fuelMinus.on('pointerdown', () => this.adjustFuel(-FUEL_LOAD_STEP));
    fuelPlus.on('pointerdown', () => this.adjustFuel(FUEL_LOAD_STEP));
    this.fuelButtons = { minus: fuelMinus, plus: fuelPlus };
    const fuelNote = text(labelX, ROW.fuelNote, '11px').setWordWrapWidth(410);
    this.fuelRow = [fuelLabel, fuelValue, fuelMinus, fuelPlus, fuelNote];

    const stintTitle = label(labelX, ROW.stintTitle, 'Stint on fresh tires and fuel');
    const stintText = () => text(labelX, 0, '13px', '#e6edf3');
    const stints = { hard: stintText(), medium: stintText(), soft: stintText() };

    this.modalValueTexts = { psi: psiValue, wing: wingValue, fuel: fuelValue, fuelNote, stints };

    this.modalConfirm = this.createModalButton(340, ROW.buttons, 'Confirm');
    this.suggestButton = this.createModalButton(470, ROW.buttons, 'Suggested');
    this.modalCancel = this.createModalButton(650, ROW.buttons, 'Cancel');
    this.suggestButton.on('pointerdown', () => {
      const suggested = this.suggest?.();
      if (!suggested || !this.modalSetup) return;
      this.modalSetup = this.fitToFeatures(suggested);
      this.refreshModalValues();
    });

    this.lower = [
      { item: stintTitle, row: ROW.stintTitle },
      { item: stints.hard, row: 0 },
      { item: stints.medium, row: 0 },
      { item: stints.soft, row: 0 },
      { item: this.modalConfirm, row: ROW.buttons },
      { item: this.suggestButton, row: ROW.buttons },
      { item: this.modalCancel, row: ROW.buttons }
    ];

    this.modal = this.scene.add.container(0, 0, [
      this.panel,
      this.modalTitle,
      this.modalBody,
      compoundLabel,
      ...COMPOUNDS.map((c) => this.compoundButtons[c]),
      psiLabel,
      psiValue,
      psiMinus,
      psiPlus,
      wingLabel,
      wingValue,
      wingMinus,
      wingPlus,
      ...this.fuelRow,
      stintTitle,
      stints.hard,
      stints.medium,
      stints.soft,
      this.modalConfirm,
      this.suggestButton,
      this.modalCancel
    ]);
    this.modal.setDepth(100);
    this.modal.setVisible(false);
  }

  private suggest: PitModalOpenOptions['suggest'] | undefined;

  isActive() {
    return this.active;
  }

  /** The buttons an e2e test presses with the real mouse (see `window.__srp.uiButtonPos`). */
  button(name: PitModalButton): Phaser.GameObjects.Text {
    switch (name) {
      case 'confirm':
        return this.modalConfirm;
      case 'suggest':
        return this.suggestButton;
      case 'wing-minus':
        return this.wingButtons.minus;
      case 'wing-plus':
        return this.wingButtons.plus;
      case 'fuel-minus':
        return this.fuelButtons.minus;
      case 'fuel-plus':
        return this.fuelButtons.plus;
      case 'compound-hard':
        return this.compoundButtons.hard;
      case 'compound-medium':
        return this.compoundButtons.medium;
      case 'compound-soft':
        return this.compoundButtons.soft;
      default:
        return name satisfies never;
    }
  }

  open(options: PitModalOpenOptions) {
    this.features = options.features;
    this.suggest = options.suggest;
    this.modalSetup = this.fitToFeatures(options.setup);
    this.stints = options.stints;
    this.pace = options.pace;
    this.fuelNote = options.fuelNote;
    this.modalTitle.setText(options.title ?? 'Pit stop');
    this.modalBody.setText(options.bodyLines.join('\n'));
    this.layout();
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

  private drawPanel(height: number) {
    const { x, y, width } = PIT_PANEL;
    this.panel.clear();
    this.panel.fillStyle(0x0f141b, 0.98);
    this.panel.fillRoundedRect(x, y, width, height, 10);
    this.panel.lineStyle(1, 0x2a3642, 1);
    this.panel.strokeRoundedRect(x, y, width, height, 10);
  }

  // A setup the rules do not offer (the medium compound, a fuel load) is traded for the closest one they do; the fuel
  // load starts from a full tank when the rules have one and the setup names none.
  private fitToFeatures(setup: Car['setup']): Car['setup'] {
    const fitted = structuredClone(setup);
    if (!this.features.medium && fitted.compound === 'medium') fitted.compound = 'hard';
    if (this.features.fuelLoad) fitted.fuelLoad ??= 100;
    else delete fitted.fuelLoad;
    return fitted;
  }

  // The fuel row and the medium line come and go with the rules; the rows below them follow.
  private layout() {
    const { medium, fuelLoad } = this.features;
    const shift = fuelLoad ? 0 : -FUEL_ROWS_HEIGHT;
    for (const item of this.fuelRow) item.setVisible(fuelLoad);
    this.showButton(this.fuelButtons.minus, fuelLoad);
    this.showButton(this.fuelButtons.plus, fuelLoad);
    this.showButton(this.compoundButtons.medium, medium);
    this.compoundButtons.soft.setX(this.compoundButtons.medium.x + (medium ? 50 : 0));
    const lines = COMPOUNDS.filter((c) => medium || c !== 'medium');
    this.modalValueTexts.stints.medium.setVisible(medium);
    lines.forEach((compound, i) => {
      this.modalValueTexts.stints[compound].setY(ROW.stint + shift + i * ROW.stintStep);
    });
    const missing = (3 - lines.length) * ROW.stintStep;
    for (const { item, row } of this.lower) {
      if (row === 0) continue;
      item.setY(row + shift - (row === ROW.buttons ? missing : 0));
    }
    this.showButton(this.suggestButton, this.suggest !== undefined);
    this.drawPanel(FULL_HEIGHT + shift - missing);
  }

  // A hidden button must not be pressable either.
  private showButton(button: Phaser.GameObjects.Text, visible: boolean) {
    button.setVisible(visible);
    if (visible) button.setInteractive({ useHandCursor: true });
    else button.disableInteractive();
  }

  private refreshModalValues() {
    if (!this.modalSetup) return;
    const setup = this.modalSetup;
    for (const compound of COMPOUNDS) {
      this.compoundButtons[compound].setStyle({
        backgroundColor: setup.compound === compound ? CHOSEN : BUTTON
      });
    }
    this.modalValueTexts.psi.setText(
      `${setup.psi.fl}/${setup.psi.fr}/${setup.psi.rl}/${setup.psi.rr}`
    );
    // The cycle budget is what the wing and the compound buy in pace; the wear shows in the stint lines below.
    this.modalValueTexts.wing.setText(`${setup.wing}  (pace ${this.pace?.(setup) ?? ''})`);
    if (this.features.fuelLoad) {
      this.modalValueTexts.fuel.setText(`${setup.fuelLoad ?? 100}%`);
      this.modalValueTexts.fuelNote.setText(this.fuelNote?.(setup) ?? '');
    }
    if (!this.stints) return;
    const stints = this.stints(setup);
    for (const compound of COMPOUNDS) {
      const chosen = setup.compound === compound;
      const text = this.modalValueTexts.stints[compound];
      text.setText(`${chosen ? '>' : ' '} ${compound.padEnd(6)} ${formatStint(stints[compound])}`);
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

  // "-" is a lighter tank (faster while it is heavy, less range), "+" a heavier one.
  private adjustFuel(delta: number) {
    if (!this.modalSetup || !this.features.fuelLoad) return;
    this.modalSetup.fuelLoad = Math.max(
      FUEL_LOAD_MIN,
      Math.min(100, (this.modalSetup.fuelLoad ?? 100) + delta)
    );
    this.refreshModalValues();
  }
}
