import type { BackendApiClient } from '../net/backend_api';
import type { SavedRace } from './recap_store';

/**
 * A race of the public history (#170), as the recap and the board replay take it. The log has no names, so cars are told
 * apart by seat.
 */
export async function loadRemoteRace(
  client: Pick<BackendApiClient, 'readRace'>,
  id: string
): Promise<SavedRace> {
  const race = await client.readRace(id);
  const names: Record<string, string> = {};
  race.log.seats.forEach((seat, i) => {
    names[String(i + 1)] = seat.isBot ? `Bot ${i + 1}` : `Player ${i + 1}`;
  });
  const laps = race.log.raceLaps;
  return {
    id: race.id,
    finishedAt: race.finishedAt,
    trackId: race.trackId,
    label: `${race.source === 'online' ? 'Online' : 'Solo'}, ${laps} ${laps === 1 ? 'lap' : 'laps'}, ${names[String(race.winnerCarId)] ?? 'someone'} won`,
    names,
    log: race.log
  };
}
