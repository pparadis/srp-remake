import type Phaser from "phaser";

export interface TextButtonOptions {
  fontSize: string;
  originX?: number;
  originY?: number;
  onClick?: () => void;
}

export class TextButton {
  private scene: Phaser.Scene;
  private text: Phaser.GameObjects.Text;

  constructor(scene: Phaser.Scene, label: string, options: TextButtonOptions) {
    this.scene = scene;
    this.text = this.scene.add.text(0, 0, label, {
      fontFamily: "monospace",
      fontSize: options.fontSize,
      color: "#0b0f14",
      backgroundColor: "#c7d1db",
      padding: { x: 10, y: 6 }
    });
    if (options.originX != null || options.originY != null) {
      this.text.setOrigin(options.originX ?? 0, options.originY ?? 0);
    }
    this.text.setInteractive({ useHandCursor: true });
    this.text.on("pointerover", () => this.text.setStyle({ backgroundColor: "#e6edf3" }));
    this.text.on("pointerout", () => this.text.setStyle({ backgroundColor: "#c7d1db" }));
    if (options.onClick) {
      this.text.on("pointerdown", () => options.onClick?.());
    }
  }

  setPosition(x: number, y: number) {
    this.text.setPosition(x, y);
  }

  setAlpha(alpha: number) {
    this.text.setAlpha(alpha);
  }

  setInteractive(enabled: boolean) {
    if (enabled) {
      this.text.setInteractive({ useHandCursor: true });
    } else {
      this.text.disableInteractive();
    }
  }

  setFixed() {
    if (typeof (this.text as { setScrollFactor?: (x: number, y?: number) => unknown }).setScrollFactor === "function") {
      (this.text as unknown as { setScrollFactor: (x: number, y?: number) => unknown }).setScrollFactor(0);
    }
  }

  getText() {
    return this.text;
  }
}
