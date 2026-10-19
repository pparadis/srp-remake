// Car.lapCount counts COMPLETED laps. A lap starts when the car crosses the start line, so a car
// that begins behind the line has -1 (lap 1 not begun) and its first crossing makes it 0.
export function lapCountAtSpawn(forwardIndex: number): number {
  return forwardIndex > 0 ? -1 : 0;
}

/** True once the car has crossed the line and is in a lap (a front-row car is already in lap 1). */
export function hasStartedLap(lapCount: number | undefined): boolean {
  return (lapCount ?? 0) >= 0;
}

export function hasFinishedRace(lapCount: number | undefined, raceLaps: number): boolean {
  return (lapCount ?? 0) >= raceLaps;
}

/** The lap the car is IN (1-based): 0 while still behind the line, never past raceLaps. */
export function lapInProgress(lapCount: number | undefined, raceLaps: number): number {
  const done = lapCount ?? 0;
  return done < 0 ? 0 : Math.min(done + 1, raceLaps);
}
