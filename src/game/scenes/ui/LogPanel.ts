import type Phaser from "phaser";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export class LogPanel {
  private scene: Phaser.Scene;
  private panel: Phaser.GameObjects.Graphics;
  private text: Phaser.GameObjects.Text;
  private rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private padding = 0;
  private lines: string[] = [];
  private maxLines = 8;

  constructor(scene: Phaser.Scene) {
    this.scene = scene;
    this.panel = this.scene.add.graphics();
    this.text = this.scene.add.text(0, 0, "", {
      fontFamily: "monospace",
      fontSize: "13px",
      color: "#c7d1db",
      lineSpacing: 4,
      wordWrap: { width: 260 }
    });
  }

  setRect(rect: Rect, padding: number) {
    this.rect = rect;
    this.padding = padding;
    this.text.setPosition(rect.x + padding, rect.y + padding);
    this.text.setWordWrapWidth(rect.w - padding * 2);
  }

  addLine(line: string) {
    this.lines.push(line);
    if (this.lines.length > this.maxLines) this.lines.shift();
    this.text.setText(this.lines.join("\n"));
  }

  draw() {
    this.panel.clear();
    this.panel.fillStyle(0x0f141b, 0.95);
    this.panel.fillRoundedRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h, 8);
    this.panel.lineStyle(1, 0x2a3642, 1);
    this.panel.strokeRoundedRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h, 8);
  }

  setFixed() {
    for (const obj of [this.panel, this.text]) {
      if (typeof (obj as { setScrollFactor?: (x: number, y?: number) => unknown }).setScrollFactor === "function") {
        (obj as unknown as { setScrollFactor: (x: number, y?: number) => unknown }).setScrollFactor(0);
      }
    }
  }
}
