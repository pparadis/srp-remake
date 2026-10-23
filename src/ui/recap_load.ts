import { createRaceContext } from '../game/race/race_engine';
import { raceRecap, type RaceRecap } from '../game/systems/race_recap';
import { parseTrack } from '../validation/track_schema';
import type { SavedRace } from './recap_store';

// The recap of a saved race. Kept apart from the page so the engine (and the rules versions) load only when a recap is
// opened: main.ts imports this lazily, like the game.
export async function buildRecap(saved: SavedRace, baseUrl: string): Promise<RaceRecap> {
  const response = await fetch(`${baseUrl}tracks/${encodeURIComponent(saved.trackId)}.json`);
  if (!response.ok) throw new Error(`Track ${saved.trackId} not found (${response.status}).`);
  const ctx = createRaceContext(parseTrack(await response.json()));
  return raceRecap(ctx, saved.log, (carId) => saved.names[String(carId)] ?? `Car ${carId}`);
}
