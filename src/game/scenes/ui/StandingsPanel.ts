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
  private headerOffset = { x: 0, y: 0 };
  private textOffset = { x: 0, y: 0 };
  private modeOffsetX = 0;
  private collapsed = false;
  private standingsMode: StandingsMode = "carId";
  private callbacks: StandingsCallbacks;

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

    this.mode = this.scene.add.text(0, 0, "Mode: Id", {
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

  setRect(rect: Rect, headerOffset: { x: number; y: number }, textOffset: { x: number; y: number }, modeOffsetX: number) {
    this.rect = rect;
    this.headerOffset = headerOffset;
    this.textOffset = textOffset;
    this.modeOffsetX = modeOffsetX;
    this.header.setPosition(rect.x + headerOffset.x, rect.y + headerOffset.y);
    this.mode.setPosition(rect.x + modeOffsetX, rect.y + headerOffset.y);
    this.list.setPosition(rect.x + textOffset.x, rect.y + textOffset.y);
    this.list.setWordWrapWidth(rect.w - textOffset.x * 2);
  }

  setLines(lines: string[]) {
    if (this.collapsed) {
      this.list.setText("");
      return;
    }
    this.list.setText(lines.join("\n"));
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
}
