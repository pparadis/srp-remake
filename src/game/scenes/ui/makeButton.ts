import type Phaser from "phaser";

interface TextButtonOptions {
  fontSize: string;
  originX?: number;
  originY?: number;
  onClick?: () => void;
}

export function makeButton(scene: Phaser.Scene, label: string, options: TextButtonOptions): Phaser.GameObjects.Text {
  const text = scene.add.text(0, 0, label, {
    fontFamily: "monospace",
    fontSize: options.fontSize,
    color: "#0b0f14",
    backgroundColor: "#c7d1db",
    padding: { x: 10, y: 6 }
  });
  if (options.originX != null || options.originY != null) {
    text.setOrigin(options.originX ?? 0, options.originY ?? 0);
  }
  text.setInteractive({ useHandCursor: true });
  text.on("pointerover", () => text.setStyle({ backgroundColor: "#e6edf3" }));
  text.on("pointerout", () => text.setStyle({ backgroundColor: "#c7d1db" }));
  if (options.onClick) text.on("pointerdown", () => options.onClick?.());
  return text;
}
