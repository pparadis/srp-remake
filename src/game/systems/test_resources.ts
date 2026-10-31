import { resourceRulesFor } from './resource_system';

// The resource rules of a 5-lap race on the oval (28 cells a lap), for tests that need a `ResourceRules` and not a race.
export const resources = resourceRulesFor({ raceLaps: 5, spineLen: 28 });
