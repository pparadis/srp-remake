import type Phaser from "phaser";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type StandingsMode = "carId" | "race";

interface StandingsCallbacks {
  onToggle?: () => void;
  onModeChange?: () => void;
}

export class StandingsPanel {
  private scene: Phaser.Scene;
  private panel: Phaser.GameObjects.Graphics;
  private header: Phaser.GameObjects.Text;
  private mode: Phaser.GameObjects.Text;
  private list: Phaser.GameObjects.Text;
  private rect: Rect = { x: 0, y: 0, w: 0, h: 0 };
  private collapsed = false;
  private standingsMode: StandingsMode = "race";
  private callbacks: StandingsCallbacks;
  private headerOffset = { x: 8, y: 6 };
  private textOffset = { x: 8, y: 26 };
  private modeOffsetX = 120;

  constructor(scene: Phaser.Scene, callbacks: StandingsCallbacks = {}) {
    this.scene = scene;
    this.callbacks = callbacks;
    this.panel = this.scene.add.graphics();
    this.header = this.scene.add.text(0, 0, "Standings [-]", {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#e6edf3"
    });
    this.header.setInteractive({ useHandCursor: true });
    this.header.on("pointerdown", () => {
      this.collapsed = !this.collapsed;
      this.callbacks.onToggle?.();
    });

    this.mode = this.scene.add.text(0, 0, "Mode: Race", {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#9fb0bf"
    });
    this.mode.setInteractive({ useHandCursor: true });
    this.mode.on("pointerdown", () => {
      this.standingsMode = this.standingsMode === "carId" ? "race" : "carId";
      this.refreshModeLabel();
      this.callbacks.onModeChange?.();
    });

    this.list = this.scene.add.text(0, 0, "", {
      fontFamily: "monospace",
      fontSize: "12px",
      color: "#c7d1db",
      lineSpacing: 4,
      wordWrap: { width: 220 }
    });
  }

  isCollapsed() {
    return this.collapsed;
  }

  getMode(): StandingsMode {
    return this.standingsMode;
  }

  getPreferredHeight(): number {
    return this.computePreferredHeight();
  }

  setRect(rect: Rect, headerOffset: { x: number; y: number }, textOffset: { x: number; y: number }, modeOffsetX: number) {
    this.headerOffset = headerOffset;
    this.textOffset = textOffset;
    this.modeOffsetX = modeOffsetX;
    this.rect = rect;
    this.header.setPosition(rect.x + this.headerOffset.x, rect.y + this.headerOffset.y);
    this.mode.setPosition(rect.x + this.modeOffsetX, rect.y + this.headerOffset.y);
    this.list.setPosition(rect.x + this.textOffset.x, rect.y + this.textOffset.y);
    this.list.setWordWrapWidth(rect.w - this.textOffset.x * 2);
  }

  setLines(lines: string[]): boolean {
    const before = this.computePreferredHeight();
    if (this.collapsed) {
      this.list.setText("");
    } else {
      this.list.setText(lines.join("\n"));
    }
    const after = this.computePreferredHeight();
    return before !== after;
  }

  draw() {
    this.panel.clear();
    if (this.collapsed) {
      this.header.setText("Standings [+]");
      this.list.setVisible(false);
      this.mode.setVisible(false);
      return;
    }
    this.panel.fillStyle(0x0f141b, 0.97);
    this.panel.fillRoundedRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h, 8);
    this.panel.lineStyle(1, 0x2a3642, 1);
    this.panel.strokeRoundedRect(this.rect.x, this.rect.y, this.rect.w, this.rect.h, 8);

    this.header.setText("Standings [-]");
    this.list.setVisible(true);
    this.mode.setVisible(true);
  }

  setFixed() {
    for (const obj of [this.panel, this.header, this.mode, this.list]) {
      if (typeof (obj as { setScrollFactor?: (x: number, y?: number) => unknown }).setScrollFactor === "function") {
        (obj as unknown as { setScrollFactor: (x: number, y?: number) => unknown }).setScrollFactor(0);
      }
    }
  }

  private refreshModeLabel() {
    this.mode.setText(this.standingsMode === "carId" ? "Mode: Id" : "Mode: Race");
  }

  private computePreferredHeight(): number {
    const topPad = this.headerOffset.y;
    const bottomPad = Math.max(8, this.textOffset.x);
    const collapsedHeight = Math.ceil(topPad + this.header.height + topPad);
    if (this.collapsed) return collapsedHeight;
    const openMinHeight = Math.ceil(topPad + Math.max(this.header.height, this.mode.height) + topPad + 8);
    const openHeight = Math.ceil(this.textOffset.y + this.list.height + bottomPad);
    return Math.max(openMinHeight, openHeight);
  }
}
