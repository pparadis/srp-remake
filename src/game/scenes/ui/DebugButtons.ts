import type Phaser from "phaser";
import { makeButton } from "./makeButton";

interface DebugButtonsCallbacks {
  onCopyDebug: () => void;
  onCopyBotDebug: () => void;
  onCopyBotDebugShort: () => void;
}

export class DebugButtons {
  private buttons: Phaser.GameObjects.Text[];

  constructor(scene: Phaser.Scene, callbacks: DebugButtonsCallbacks) {
    const make = (label: string, onClick: () => void) =>
      makeButton(scene, label, { fontSize: "14px", originX: 0, originY: 1, onClick });
    this.buttons = [
      make("Copy debug", callbacks.onCopyDebug),
      make("Copy bot debug", callbacks.onCopyBotDebug),
      make("Copy bot debug short", callbacks.onCopyBotDebugShort)
    ];
  }

  layout(width: number, height: number, padding: number, bottomButtonYPad: number) {
    let x = padding + 4;
    let y = height - bottomButtonYPad;
    const gap = 8;
    for (const button of this.buttons) {
      const buttonWidth = button.width;
      if (x + buttonWidth > width - padding) {
        x = padding + 4;
        y -= button.height + gap;
      }
      button.setPosition(x, y);
      x += buttonWidth + gap;
    }
  }

  getTexts() {
    return this.buttons;
  }

  setFixed() {
    for (const button of this.buttons) button.setScrollFactor(0);
  }
}
