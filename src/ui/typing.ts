/** A form field has the focus (the chat, a sandbox field): the letters typed there are text, not game keys. */
export function isTypingTarget(): boolean {
  const active = document.activeElement;
  return active instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(active.tagName);
}
