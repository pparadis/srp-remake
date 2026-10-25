// Writes public/tracks/<trackId>.json for every spec in track_specs.ts (#175): npm run gen:tracks
import { writeFileSync } from 'node:fs';
import { generateTrack } from './gen_track';
import { TRACK_SPECS } from './track_specs';

for (const spec of TRACK_SPECS) {
  const file = `public/tracks/${spec.trackId}.json`;
  writeFileSync(file, `${JSON.stringify(generateTrack(spec), null, 2)}\n`, 'utf-8');
  console.log(`Generated: ${file}`);
}
