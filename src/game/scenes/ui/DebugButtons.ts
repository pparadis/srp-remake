import type Phaser from "phaser";
import { TextButton } from "./TextButton";

export interface DebugButtonsCallbacks {
  onCopyDebug: () => void;
  onCopyBotDebug: () => void;
  onCopyBotDebugShort: () => void;
}

export class DebugButtons {
  private copyDebugButton: TextButton;
  private copyBotDebugButton: TextButton;
  private copyBotDebugShortButton: TextButton;

  constructor(scene: Phaser.Scene, callbacks: DebugButtonsCallbacks) {
    this.copyDebugButton = new TextButton(scene, "Copy debug", {
      fontSize: "14px",
      originX: 0,
      originY: 1,
      onClick: callbacks.onCopyDebug
    });
    this.copyBotDebugButton = new TextButton(scene, "Copy bot debug", {
      fontSize: "14px",
      originX: 0,
      originY: 1,
      onClick: callbacks.onCopyBotDebug
    });
    this.copyBotDebugShortButton = new TextButton(scene, "Copy bot debug short", {
      fontSize: "14px",
      originX: 0,
      originY: 1,
      onClick: callbacks.onCopyBotDebugShort
    });
  }

  layout(width: number, height: number, padding: number, bottomButtonYPad: number) {
    const buttons = [this.copyDebugButton, this.copyBotDebugButton, this.copyBotDebugShortButton];
    let x = padding + 4;
    let y = height - bottomButtonYPad;
    const gap = 8;
    for (const button of buttons) {
      const textObj = button.getText();
      const buttonWidth = textObj.width;
      if (x + buttonWidth > width - padding) {
        x = padding + 4;
        y -= textObj.height + gap;
      }
      button.setPosition(x, y);
      x += buttonWidth + gap;
    }
  }

  setFixed() {
    this.copyDebugButton.setFixed();
    this.copyBotDebugButton.setFixed();
    this.copyBotDebugShortButton.setFixed();
  }
}
