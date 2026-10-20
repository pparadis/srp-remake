/**
 * The value, or a thrown error that says what was missing. For a lookup that cannot miss by construction (an id the
 * code just read from the same map, an index inside the loop bounds): the guide asks for a runtime check, not a
 * `!` (#77). Keep `what` a constant: it sits in hot loops, so it must not build a string.
 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${what}.`);
  return value;
}
