export type TrackTag = "START_FINISH" | "PIT_ENTRY" | "PIT_BOX" | "PIT_EXIT";

export interface Vec2 {
  x: number;
  y: number;
}

export interface TrackCell {
  id: string;
  zoneIndex: number;  // 1..N
  laneIndex: number;  // 0..3
  pos: Vec2;
  next: string[];
  tags?: TrackTag[];
}

export interface TrackData {
  trackId: string;
  zones: number;
  lanes: number; // 4 with pit lane
  cells: TrackCell[];
}
