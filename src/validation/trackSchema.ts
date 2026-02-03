import { z } from "zod";

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
  tags: z.array(z.enum(["START_FINISH", "PIT_ENTRY", "PIT_BOX", "PIT_EXIT"])).optional()
});

export const trackSchema = z.object({
  trackId: z.string().min(1),
  zones: z.number().int().min(1),
  lanes: z.number().int().min(1),
  cells: z.array(cellSchema).min(1)
});

export type TrackSchema = z.infer<typeof trackSchema>;
