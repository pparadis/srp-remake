import type Phaser from "phaser";
import type { Car } from "../../types/car";

interface PitModalTexts {
  compound: Phaser.GameObjects.Text;
  psi: Phaser.GameObjects.Text;
  wing: Phaser.GameObjects.Text;
}

export interface PitModalOpenOptions {
  setup: Car["setup"];
  bodyLines: string[];
  onConfirm: (setup: Car["setup"]) => void;
  onCancel: () => void;
}

export class PitModal {
  private scene: Phaser.Scene;
  private modal: Phaser.GameObjects.Container;
  private modalTitle: Phaser.GameObjects.Text;
  private modalBody: Phaser.GameObjects.Text;
  private modalConfirm: Phaser.GameObjects.Text;
  private modalCancel: Phaser.GameObjects.Text;
  private modalSetup: Car["setup"] | null = null;
  private modalValueTexts: PitModalTexts;
  private active = false;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;

    const panel = this.scene.add.graphics();
    panel.fillStyle(0x0f141b, 0.98);
    panel.fillRoundedRect(320, 200, 460, 270, 10);
    panel.lineStyle(1, 0x2a3642, 1);
    panel.strokeRoundedRect(320, 200, 460, 270, 10);

    this.modalTitle = this.scene.add.text(350, 220, "Pit stop", {
      fontFamily: "monospace",
      fontSize: "18px",
      color: "#e6edf3"
    });
    this.modalBody = this.scene.add.text(350, 255, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#c7d1db",
      lineSpacing: 4,
      wordWrap: { width: 400 }
    });

    const fieldY = 330;
    const lineH = 26;
    const labelX = 350;
    const valueX = 470;
    const controlX = 620;

    const compoundLabel = this.scene.add.text(labelX, fieldY, "Compound", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#9fb0bf"
    });
    const compoundValue = this.scene.add.text(valueX, fieldY, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#e6edf3"
    });
    const compoundToggle = this.createModalButton(controlX, fieldY - 6, "Toggle");
    compoundToggle.setScale(0.85);
    compoundToggle.on("pointerdown", () => {
      if (!this.modalSetup) return;
      this.modalSetup.compound = this.modalSetup.compound === "soft" ? "hard" : "soft";
      this.refreshModalValues();
    });

    const psiLabel = this.scene.add.text(labelX, fieldY + lineH, "PSI FL/FR/RL/RR", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#9fb0bf"
    });
    const psiValue = this.scene.add.text(labelX, fieldY + lineH + 12, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#e6edf3"
    });
    const psiMinus = this.createModalButton(controlX, fieldY + lineH + 8, "-");
    const psiPlus = this.createModalButton(controlX + 40, fieldY + lineH + 8, "+");
    psiMinus.setScale(0.85);
    psiPlus.setScale(0.85);
    psiMinus.on("pointerdown", () => this.adjustPsi(-1));
    psiPlus.on("pointerdown", () => this.adjustPsi(1));

    const wingLabel = this.scene.add.text(labelX, fieldY + lineH * 2 + 16, "Wing F/R", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#9fb0bf"
    });
    const wingValue = this.scene.add.text(valueX, fieldY + lineH * 2 + 16, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#e6edf3"
    });
    const wingMinus = this.createModalButton(controlX, fieldY + lineH * 2 + 12, "-");
    const wingPlus = this.createModalButton(controlX + 40, fieldY + lineH * 2 + 12, "+");
    wingMinus.setScale(0.85);
    wingPlus.setScale(0.85);
    wingMinus.on("pointerdown", () => this.adjustWing(-1));
    wingPlus.on("pointerdown", () => this.adjustWing(1));

    this.modalValueTexts = {
      compound: compoundValue,
      psi: psiValue,
      wing: wingValue
    };

    this.modalConfirm = this.createModalButton(360, 435, "Confirm");
    this.modalCancel = this.createModalButton(520, 435, "Cancel");

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
      this.modalConfirm,
      this.modalCancel
    ]);
    this.modal.setDepth(100);
    this.modal.setVisible(false);
  }

  isActive() {
    return this.active;
  }

  open(options: PitModalOpenOptions) {
    this.modalSetup = structuredClone(options.setup);
    this.modalBody.setText(options.bodyLines.join("\n"));
    this.refreshModalValues();
    this.modal.setVisible(true);
    this.active = true;

    this.modalConfirm.removeAllListeners("pointerdown");
    this.modalCancel.removeAllListeners("pointerdown");

    this.modalConfirm.once("pointerdown", () => {
      if (!this.modalSetup) return;
      options.onConfirm(this.modalSetup);
    });

    this.modalCancel.once("pointerdown", () => {
      options.onCancel();
    });
  }

  close() {
    this.modalSetup = null;
    this.modal.setVisible(false);
    this.active = false;
  }

  setFixed() {
    if (typeof (this.modal as { setScrollFactor?: (x: number, y?: number) => unknown }).setScrollFactor === "function") {
      (this.modal as unknown as { setScrollFactor: (x: number, y?: number) => unknown }).setScrollFactor(0);
    }
    for (const child of this.modal.list) {
      if (typeof (child as { setScrollFactor?: (x: number, y?: number) => unknown }).setScrollFactor === "function") {
        (child as unknown as { setScrollFactor: (x: number, y?: number) => unknown }).setScrollFactor(0);
      }
    }
  }

  private createModalButton(x: number, y: number, label: string): Phaser.GameObjects.Text {
    const txt = this.scene.add.text(x, y, label, {
      fontFamily: "monospace",
      fontSize: "14px",
      color: "#0b0f14",
      backgroundColor: "#c7d1db",
      padding: { x: 10, y: 6 }
    });
    txt.setInteractive({ useHandCursor: true });
    txt.on("pointerover", () => txt.setStyle({ backgroundColor: "#e6edf3" }));
    txt.on("pointerout", () => txt.setStyle({ backgroundColor: "#c7d1db" }));
    return txt;
  }

  private refreshModalValues() {
    if (!this.modalSetup) return;
    this.modalValueTexts.compound.setText(this.modalSetup.compound);
    this.modalValueTexts.psi.setText(
      `${this.modalSetup.psi.fl}/${this.modalSetup.psi.fr}/${this.modalSetup.psi.rl}/${this.modalSetup.psi.rr}`
    );
    this.modalValueTexts.wing.setText(`${this.modalSetup.wingFrontDeg}/${this.modalSetup.wingRearDeg}`);
  }

  private adjustPsi(delta: number) {
    if (!this.modalSetup) return;
    const clamp = (v: number) => Math.max(15, Math.min(35, v + delta));
    this.modalSetup.psi.fl = clamp(this.modalSetup.psi.fl);
    this.modalSetup.psi.fr = clamp(this.modalSetup.psi.fr);
    this.modalSetup.psi.rl = clamp(this.modalSetup.psi.rl);
    this.modalSetup.psi.rr = clamp(this.modalSetup.psi.rr);
    this.refreshModalValues();
  }

  private adjustWing(delta: number) {
    if (!this.modalSetup) return;
    const clamp = (v: number) => Math.max(0, Math.min(20, v + delta));
    this.modalSetup.wingFrontDeg = clamp(this.modalSetup.wingFrontDeg);
    this.modalSetup.wingRearDeg = clamp(this.modalSetup.wingRearDeg);
    this.refreshModalValues();
  }
}
