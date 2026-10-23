import { describe, expect, it } from 'vitest';
import { PLAYER_NAME_WORDS, randomPlayerName } from './player_name';

describe('randomPlayerName', () => {
  it('is adjective_noun, from the first and the last words at the ends of the random range', () => {
    const { adjectives, nouns } = PLAYER_NAME_WORDS;
    expect(randomPlayerName(() => 0)).toBe(`${adjectives[0]}_${nouns[0]}`);
    expect(randomPlayerName(() => 0.999999)).toBe(`${adjectives.at(-1)}_${nouns.at(-1)}`);
  });

  it('always fits the 24-character name field, whichever words come up', () => {
    const { adjectives, nouns } = PLAYER_NAME_WORDS;
    const longest =
      Math.max(...adjectives.map((w) => w.length)) + 1 + Math.max(...nouns.map((w) => w.length));
    expect(longest).toBeLessThanOrEqual(24);
  });

  it('has no repeated words and only lowercase letters', () => {
    const { adjectives, nouns } = PLAYER_NAME_WORDS;
    for (const list of [adjectives, nouns]) {
      expect(new Set(list).size).toBe(list.length);
      for (const word of list) expect(word).toMatch(/^[a-z]+$/);
    }
  });

  it('varies with the random source', () => {
    const names = new Set(
      Array.from({ length: 50 }, (_x, i) => randomPlayerName(() => (i * 0.137) % 1))
    );
    expect(names.size).toBeGreaterThan(10);
  });
});
