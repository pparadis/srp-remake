// A default player name like Docker's container names: adjective_noun, from racing words ("steady_hairpin").
// Every word is at most 8 letters, so a name fits the 24-character name field.
const ADJECTIVES = [
  'bold',
  'brave',
  'calm',
  'daring',
  'eager',
  'fast',
  'fierce',
  'happy',
  'keen',
  'lucky',
  'nimble',
  'plucky',
  'quick',
  'rapid',
  'sharp',
  'sleek',
  'smooth',
  'steady',
  'swift',
  'zippy'
];
const NOUNS = [
  'apex',
  'bend',
  'chicane',
  'clutch',
  'curb',
  'drift',
  'flag',
  'gear',
  'grid',
  'hairpin',
  'kerb',
  'lap',
  'piston',
  'pitstop',
  'podium',
  'rocket',
  'slick',
  'spoiler',
  'turbo',
  'wheel'
];

/** `random` is injectable for tests; it returns a number in [0, 1) like `Math.random`. */
export function randomPlayerName(random: () => number = Math.random): string {
  const pick = (words: string[]) => words[Math.floor(random() * words.length)] ?? 'fast';
  return `${pick(ADJECTIVES)}_${pick(NOUNS)}`;
}

export const PLAYER_NAME_WORDS = { adjectives: ADJECTIVES, nouns: NOUNS };
