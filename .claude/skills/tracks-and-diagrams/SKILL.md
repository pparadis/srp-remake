---
name: tracks-and-diagrams
description: Tracks and rule diagrams guide: the track list and Track select, the gen_track generator and its specs, the oval tracks, how docs/img diagrams are generated and checked. Read before adding or changing a track, or adding a rule that needs a diagram.
---

# Tracks and rule diagrams

- Track data in `public/tracks/`; the tracks a race can be played on are listed in `src/game/track_ids.ts` (id and name,
  loaded by the page; `track_ids.test.ts` checks the list against the files and `backend/src/tracks.ts`). The Quick
  race card and the lobby card have a Track select (`lobbyTrack`): solo keeps it in `soloSettings.trackId`, online it
  is the lobby's `trackId`; `RaceComposition.trackId` goes to `startGame`, the registry (`REG_TRACK_ID`) and
  `BootScene`, which loads that JSON. Uploads, saved recaps and the replay use the race's own `trackId`.
- Track generator in `tools/`; track validation in `src/validation/`. `tools/gen_track.ts` (#175) builds a track from
  a closed centre line: a polygon of `corners` rounded by a radius is lane 1 (the right-hand lane, clockwise on screen
  or not), lanes 2 and 3 are exact offsets to its left and the pit lane an offset to its right (7 cells, the entry one
  cell before the line, boxes on its 3rd and 4th). Cells are `cellLength` apart on each stretch (a straight, a bend),
  the stretches being cut alike in every lane so the straights stay in line; an outer lane has more cells in a bend,
  like the oval. A track is a spec in `tools/track_specs.ts` and `npm run gen:tracks` writes its JSON (a test fails on a
  stale file); a lane that does not fit in a bend, a start line off the straight or corners too close for their radii
  throw. `validateTrack` also rejects two cells closer than 20. `oval16_3lanes.json` is older (its script is gone) and stays
  as it is, since the rule goldens and diagrams are made on it; `OVAL16` in the specs rebuilds it, and a test compares
  positions, zones, tags and the pit. `oval32_3lanes` is the same oval twice as big (56 cells a lap). A bigger track is
  a longer lap, not smaller cells: cars and cells keep their size, the camera fits the whole board, and the baked track
  texture is capped by `trackBakeScale` (`rendering/track_bake.ts`): the iOS canvas limit (`MAX_TRACK_TEXTURE_PIXELS`)
  and the WebGL renderer's own `getMaxTextureSize()` per side.
- Rule diagrams in `docs/img/` are generated from the engine by `tools/diagrams/` (`npm run gen:diagrams`: SVG plus a
  PNG, and `diagrams.lock.json`, which ties each PNG to the SVG it was rendered from). A scenario (`scenario.ts`) is a
  race position built with the engine's own tools; the numbers come from `computeTargets` and `movePath`, and a wrong
  example throws. They are kept current three ways: the pre-commit hook regenerates them when engine code, the generator
  or a track is staged; `diagrams.test.ts` fails CI on a stale SVG, a PNG not rendered from its SVG, a file no diagram
  makes, or a diagram no `docs/*.md` embeds. So after a rule change look at the changed picture before you commit it.
  New significant rule: add its scenario to `allDiagrams` (`tools/diagrams/index.ts`) and embed `img/<name>.svg` next to
  its paragraph in the docs. Plan: issue #105.
