import { describe, expect, it, vi } from 'vitest';
import { pinToScreen } from './pin_to_screen';

describe('pinToScreen', () => {
  it('sets the scroll factor to 0 on an object that has one', () => {
    const setScrollFactor = vi.fn();
    pinToScreen({ setScrollFactor });
    expect(setScrollFactor).toHaveBeenCalledWith(0);
  });

  it('leaves an object without one alone', () => {
    expect(() => pinToScreen({})).not.toThrow();
    expect(() => pinToScreen({ setScrollFactor: 3 })).not.toThrow();
  });
});
