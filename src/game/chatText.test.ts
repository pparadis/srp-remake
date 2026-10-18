import { describe, expect, it } from 'vitest';
import { CHAT_MAX_GRAPHEMES, chatLength, normalizeChatText } from './chatText';

describe('chatLength', () => {
  it('counts what the player sees, not code units', () => {
    expect(chatLength('hello')).toBe(5);
    expect(chatLength('👍')).toBe(1);
    expect(chatLength('👨‍👩‍👧')).toBe(1);
    expect(chatLength('🇨🇦')).toBe(1);
    expect(chatLength('é')).toBe(1);
  });
});

describe('normalizeChatText', () => {
  it('keeps a plain message and trims it', () => {
    expect(normalizeChatText('  gg wp 👍  ')).toEqual({ ok: true, text: 'gg wp 👍' });
  });

  it('turns line breaks and tabs into spaces and drops other control characters', () => {
    expect(normalizeChatText('a\nb\r\nc\td')).toEqual({ ok: true, text: 'a b  c d' });
    expect(normalizeChatText('a\u0000b\u0007c\u001b[0m')).toEqual({ ok: true, text: 'abc[0m' });
  });

  it('normalizes to NFC', () => {
    expect(normalizeChatText('é')).toEqual({ ok: true, text: 'é' });
  });

  it('rejects empty and whitespace-only text', () => {
    expect(normalizeChatText('')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeChatText(' \n\t ')).toEqual({ ok: false, reason: 'empty' });
    expect(normalizeChatText('\u0000\u0001')).toEqual({ ok: false, reason: 'empty' });
  });

  it('allows 100 graphemes and rejects 101', () => {
    expect(normalizeChatText('a'.repeat(CHAT_MAX_GRAPHEMES)).ok).toBe(true);
    expect(normalizeChatText('a'.repeat(CHAT_MAX_GRAPHEMES + 1))).toEqual({
      ok: false,
      reason: 'too_long'
    });
  });

  it('counts emoji as one each, so 100 thumbs fit', () => {
    expect(normalizeChatText('👍'.repeat(CHAT_MAX_GRAPHEMES)).ok).toBe(true);
    expect(normalizeChatText('👍'.repeat(CHAT_MAX_GRAPHEMES + 1)).ok).toBe(false);
  });

  it('holds a family emoji to the 400 code-unit bound too (8 units each: 50 fit, 51 do not)', () => {
    expect(normalizeChatText('👨‍👩‍👧'.repeat(50)).ok).toBe(true);
    expect(normalizeChatText('👨‍👩‍👧'.repeat(51))).toEqual({ ok: false, reason: 'too_long' });
  });

  it('bounds size too: a few graphemes with endless combining marks are rejected', () => {
    const zalgo = 'a' + '́'.repeat(500);
    expect(chatLength(zalgo)).toBe(1);
    expect(normalizeChatText(zalgo)).toEqual({ ok: false, reason: 'too_long' });
  });
});
