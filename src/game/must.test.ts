import { describe, expect, it } from 'vitest';
import { must } from './must';

describe('must', () => {
  it('returns the value, including falsy ones', () => {
    expect(must(0, 'zero')).toBe(0);
    expect(must('', 'empty')).toBe('');
    expect(must(false, 'flag')).toBe(false);
  });

  it('throws an error that names what is missing', () => {
    expect(() => must(undefined, 'cell')).toThrow('Missing cell.');
    expect(() => must(new Map<string, number>().get('x'), 'cost')).toThrow('Missing cost.');
    expect(() => must(null, 'row')).toThrow('Missing row.');
  });
});
