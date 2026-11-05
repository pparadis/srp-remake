---
name: debug-tools
description: Debug tools guide: F and C overlays, Copy debug, the sandbox (?sandbox), the build version line, the frame-rate readout and probes. Use when debugging a race, reproducing a position or measuring frame rate.
---

# Debugging Tools

- In‑game debug:
  - Press `F` to toggle forwardIndex overlay (also shows full cell debug text in the HUD); `C` toggles cars+moves.
  - “Copy debug” button copies a JSON snapshot with car + movement context.
  - “Copy bot debug” button copies structured bot decision traces.
- Sandbox (solo dev tool): open the app with `?sandbox` (add `&seed=N`; `&pos=<base64>` starts from a position), then Quick race.
  `E` toggles edit mode (bots wait): drag any car to any free cell, press a car to make it the one to play, edit its
  cell, lap, tire, fuel, compound, driver and move points in the panel; targets recompute live. `E` again plays on with
  the normal rules. "Copy as test" copies the position as a vitest case (offered targets as the expectation: edit the
  wrong entry and it is the failing test), "Copy link" a `?sandbox&pos=` URL, "Load position" takes a "Copy debug"
  snapshot (same car count only). Phaser-free logic in `src/game/race/sandbox.ts`, panel in `src/ui/sandbox_panel.ts`,
  the e2e spec is `e2e/sandbox.spec.ts`. Plan and decisions: issue #38.
- The build version is shown bottom right on the home and lobby screens, not in a race (it sat over the board, on a phone over the bottom kerb), since a home-screen app can run an older copy than the browser (`src/ui/version.ts`): `web <sha> · <build day> ·
server <sha>`, amber when the server runs another commit (a deploy is pending); a click copies the full commits.
  The web side is `__GIT_SHA__` / `__BUILD_DATE__` (vite `define`), the server side is `/health`'s `sha`.
- Frame-rate readout (issue #79): press `P` during a race (or add `?fps` to the URL; a small `FPS` button shows on touch
  screens, in the right column or the phone drawer) for a line at the bottom left, out of the layout flow so it never
  moves the track it measures: `fps 58 · worst frame 34 ms`. `fps` is the frames the game rendered in the
  last second (Phaser's `postrender`, `src/ui/fps_meter.ts`, so a frame-rate cap shows up in it); `worst frame` is the
  longest gap between two renders in that second (a saturated main thread shows there first). Works in solo and online.
  Use it to compare before and after a rendering change, on the machine where it feels slow. No need to read it by
  hand on a desktop: `node tools/fps_probe.mjs [--browser chrome --browser firefox] [--runs 3]` (#232) plays a solo race
  in a headed browser (needs a display; Vite dev server, so the adaptive rate and `__srp` are there) and logs that line
  through idle, a car drag, wheel zoom, a pan and a turn with glides, with the GL renderer string so a software-GL run
  cannot pass for a GPU one. `PROBE_HEADED=1 PROBE_CHANNEL=chrome npm run probe:cpu` does the CPU probe on the real GPU.
- Snapshot includes `version` + `gitSha` and the race `seed` for reproducibility (`?seed=N`).
