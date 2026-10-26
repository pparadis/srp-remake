// The one rule for a chat message, used by the client (the "n/100" hint, Send) and by the backend (which bundles
// it with the engine). Phaser-free.

export const CHAT_MAX_GRAPHEMES = 100;
// One grapheme can carry unlimited combining marks ("zalgo"), so the grapheme count alone does not bound size.
export const CHAT_MAX_UNITS = 400;

export type ChatTextResult =
  { ok: true; text: string } | { ok: false; reason: 'empty' | 'too_long' };

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** What the player sees as characters: 👍 and 👨‍👩‍👧 count 1. */
export function chatLength(text: string): number {
  return [...segmenter.segment(text)].length;
}

export function normalizeChatText(raw: string): ChatTextResult {
  const text = raw
    .normalize('NFC')
    .replace(/[\r\n\t\u2028\u2029]/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
  if (text.length === 0) return { ok: false, reason: 'empty' };
  if (text.length > CHAT_MAX_UNITS || chatLength(text) > CHAT_MAX_GRAPHEMES) {
    return { ok: false, reason: 'too_long' };
  }
  return { ok: true, text };
}
