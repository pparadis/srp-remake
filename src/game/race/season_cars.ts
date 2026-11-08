import type { PersonalityKey } from '../systems/bot_style';

/**
 * What a season race (#273) pins on its cars, by car index (car 1 is index 0): the names shown, the styles the bots
 * play, and the grid slot of each car when it is not the seed's (the reversed grid). Its own file so that the season
 * model, which the backend also bundles, does not pull the race session in.
 */
export interface SeasonCars {
  names?: string[];
  styles?: PersonalityKey[];
  grid?: number[];
}
