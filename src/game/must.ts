/**
 * The value, or a thrown error that says what was missing. For a lookup that cannot miss by construction (an id the
 * code just read from the same map, an index inside the loop bounds): the guide asks for a runtime check, not a
 * `!` (#77). Keep `what` a constant in a hot loop (the route search): it is built even when nothing is missing. DOM
 * helpers may put the id in it.
 */
export function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`Missing ${what}.`);
  return value;
}
