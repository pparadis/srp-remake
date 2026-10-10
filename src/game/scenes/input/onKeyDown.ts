import type Phaser from "phaser";

/**
 * `keyboard.on("keydown-X", handler)`, but the handler runs once per key press.
 *
 * Phaser 3.90 re-reads its whole keyboard queue on every key event and only empties it on the next frame; its
 * duplicate check skips an event only when it is the one handled just before. With another key still queued
 * (a Tab a moment earlier, or a slow frame), the key's keyup replays its keydown: a toggle fires twice and seems
 * ignored (issue #41, the sandbox E step). The replay is the same DOM event object, so skip an event already seen.
 */
export function onKeyDown(
  scene: Phaser.Scene,
  keyName: string,
  handler: (event: KeyboardEvent) => void
): void {
  let last: KeyboardEvent | null = null;
  scene.input.keyboard?.on(`keydown-${keyName}`, (event: KeyboardEvent) => {
    if (event === last) return;
    last = event;
    handler(event);
  });
}
