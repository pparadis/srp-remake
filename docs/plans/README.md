# Plans

Plans written ahead of time. Nothing here is started until the owner decides to.

Each plan has a status: **Planned**, **In progress**, **Done** or **Dropped**. Keep it current in two places, this
table and the `Status:` line at the top of the plan. Add the PR or commit next to it once work starts. Shipped plans
stay here as a record; don't delete them.

| Plan                                         | Status                  | Summary                                                                                                                                                                                                                            |
| -------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [canvas-renderer.md](canvas-renderer.md)     | Done (PR #17)           | Switch Phaser from WebGL (`AUTO`) to Canvas in production and e2e; refresh 2 screenshot baselines.                                                                                                                                 |
| [testing-pyramid.md](testing-pyramid.md)     | Planned                 | Extract a Phaser-free race session from `RaceScene`, test the HUD, turn loop and online state below e2e, then trim e2e from 23 tests to about 8 journeys and screenshots.                                                          |
| [pass-and-return.md](pass-and-return.md)     | Done (PR #26, #28, #30) | Allow passing a blocker through an adjacent lane and rejoining your own lane in one move, and price every lane change at +1 move point (also for today's rare zig-zags). Start after #19 (bot personalities) merges.               |
| [ponytail-trim.md](ponytail-trim.md)         | Done (PR #21, #24)      | Over-engineering audit cuts: unused ESLint plugin, unused exports. Files touched by PR #19 deferred.                                                                                                                               |
| [welcoming-home.md](welcoming-home.md)       | Planned                 | Home page that sells the game: hero with a live SVG mini track (the real track, CSS/SVG-animated cars), 3 selling points, a big "Race now" CTA, online as secondary, how-it-works; no Phaser on home.                              |
| [sandbox-mode.md](sandbox-mode.md)           | Done (PR #29)           | `?sandbox` solo dev tool: drag any car to any cell, pick the active car, edit its points/lap/tire/fuel, see targets live, play on; "Copy as test" turns a position into a vitest case.                                             |
| [bot-tuning-review.md](bot-tuning-review.md) | Planned                 | Review the bot levels after the passing changes (#28, #30): Hard's lead over Normal fell from 0.17 to 0.07 places; measure wider, check the personalities and the human baseline, tune Hard only if the owner wants a bigger lead. |
