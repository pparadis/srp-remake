import { z } from 'zod';
import type { TrackData } from '../game/types/track';

const vec2Schema = z.object({
  x: z.number(),
  y: z.number()
});

const cellSchema = z.object({
  id: z.string().min(1),
  zoneIndex: z.number().int().min(1),
  laneIndex: z.number().int().min(0).max(3),
  forwardIndex: z.number().int().min(0),
  pos: vec2Schema,
  next: z.array(z.string().min(1)),
  tags: z
    .array(z.enum(['START_FINISH', 'PIT_ENTRY', 'PIT_BOX', 'PIT_EXIT', 'PIT_LINE']))
    .exactOptional()
});

export const trackSchema = z.object({
  trackId: z.string().min(1),
  zones: z.number().int().min(1),
  lanes: z.number().int().min(1),
  cells: z.array(cellSchema).min(1)
});

/** A track file read as data (an imported JSON, a fetch): checked at runtime and typed, no `as` (#77). */
export function parseTrack(json: unknown): TrackData {
  return trackSchema.parse(json);
}
