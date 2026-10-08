# A welcoming home page

Status: Planned

## Context

Today the home screen (`#screen-home` in `index.html`) is a single grey card with five things on it: the title
"Street Racing Prototype", a name field, two buttons and a lobby-code field. Nothing on it says what the game is or why
it is fun.

The goal is a first screen that sells the game in a few seconds:

- it's a turn-based racing strategy game, where you manage tires, fuel and pit stops;
- you can race bots at 3 levels, or friends online by link;
- one obvious button starts a race.

The page must stay light. It is plain DOM and CSS with no new dependency, and Phaser does not start on the home page:
`smoke` and `flow` assert there is no canvas there.

## Design

Two columns on desktop, stacked on a phone.

1. **Hero (left/top)**
   - Title and a one-line tagline, e.g. _"Turn-based racing. Every lap is a decision."_
   - Below them, a **live mini track**: an inline SVG of the real track built from
     `public/tracks/oval16_3lanes.json`. It shows the 3 lanes as polylines in `forwardIndex` order, the pit lane
     dashed, and the start line.
   - 3 car sprites (`public/assets/kenney/car-*.png`) lap it with SVG `<animateMotion>` at different speeds, and one of
     them dives into the pit lane now and then. There is no JS loop and no canvas.
   - `prefers-reduced-motion: reduce` turns the animation off, leaving a static grid.
2. **Pitch: 3 short points with small icons**
   - _Plan your stint_: tires and fuel wear with every move, and lanes cost differently.
   - _Box at the right time_: pit stops win or lose races.
   - _Race bots or friends_: Easy, Normal and Hard bots, or an online lobby you share by link.
3. **Call to action (the existing card, restyled; same ids and `data-testid`s)**
   - "Quick race vs bots" becomes the large primary button, labelled **Race now**. The `data-testid` stays
     `home-quick`.
   - The name field moves under it as "Racing as: [Player]".
   - Online sits underneath as a secondary group: "Create lobby" and "Join with code".
4. **How it works (3 steps, one line each)**: drag your car to a highlighted cell → watch your tires and fuel → first
   across the line after N laps wins.
5. The existing version footer stays as it is.

## Implementation

- `index.html`: restructure `#screen-home` with the hero, pitch, CTA and how-it-works sections. Keep every existing id
  and `data-testid` so `main.ts`, `main.test.ts` and e2e are unaffected. Pick the text for the lightest wording.
  - Optional: `<title>` "srp-remake" → the game name.
- New `src/ui/homeTrack.ts` (~40 lines), Phaser-free: `renderHomeTrack(svg, track)`.
  - Imports the track JSON statically (Vite JSON import, so there's no fetch on load).
  - Groups the cells by `laneIndex`, sorts them by `forwardIndex`, closes each main lane into a path, and sets
    `viewBox` from the bounds of `pos`.
  - Adds the cars with `<animateMotion>` and `<mpath>` on lane paths.
  - Reuses the car colors and sprites the race uses (`carColor` and the kenney PNGs), so it stays a single source.
- `src/main.ts`: call `renderHomeTrack` once at startup (home only).
- `src/style.css`, with the existing tokens and `monospace` look:
  - a home grid layout;
  - the hero and big CTA styles;
  - a `@media (max-width: 720px)` stacked layout with a 16 px gutter;
  - `@media (prefers-reduced-motion: reduce)`.
  - Everything is scoped under `#screen-home`, so lobby and race are untouched.

Not doing: an attract-mode replay of a real bot race, a hero image or video asset, marketing copy beyond a few lines, a
leaderboard, and a "last result" card. Add them later if the page still feels empty.

## Open question for the owner

- The name: is "Street Racing Prototype" the name to show, or is there a better one? The plan keeps it until decided.

## Tests

- `src/ui/homeTrack.test.ts` (jsdom):
  - one path per main lane plus the pit lane;
  - the paths follow `forwardIndex` order;
  - the `viewBox` covers every cell;
  - the cars reference existing paths.
- `main.test.ts`: the home page still starts no game, and "Race now" (`home-quick`) still leads to the solo lobby.
  The existing tests should pass unchanged.
- e2e: no new behavior test. Add one home screenshot (`home.png`) to `smoke.spec.ts` with animations disabled, since
  this is a visual change. Per the testing-pyramid plan, e2e is for journeys and pixels.

## Verification

- `npm test`, `npm run test:coverage`, `npm run lint`, `npm run build`. Locally, run only the `smoke` and `flow` e2e
  specs.
- Manual: `npm run dev` at desktop width and at 375 px.
  - Check the CTA is visible without scrolling on a laptop screen.
  - Check the animation is smooth and turns off with reduced motion (DevTools rendering emulation).
  - Check CPU use stays near idle on the home page (Performance panel).
