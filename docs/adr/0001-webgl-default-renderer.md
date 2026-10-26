# ADR 0001: WebGL is the default renderer

- Status: accepted (2026-10-26)
- Issue: #232, shipped in #233
- Replaces: the earlier rule "Canvas on purpose" (AGENTS.md, "Race HUD")

## Context

The game used Phaser's Canvas renderer on purpose: it is a turn-based board, and _software_ WebGL cost about 14x the CPU
of Canvas (`tools/cpuProbe.mjs`, headless Chromium on SwiftShader). Phaser 4 (#230) now calls Canvas deprecated (still
there, no removal date; "WebGL for all new projects"), and every new Phaser 4 feature is WebGL only: filters (glow,
shadow, bloom, vignette), tint modes, lighting, GPU layers.

#233 added a switch (`?renderer=webgl|canvas`, one build, both renderers) and fixed what broke on WebGL (a hidden 0x0
container reaching the renderer; `keepGameSizeInSync` now ignores it).

## Decision

WebGL is the default renderer. `?renderer=canvas` picks Canvas. Canvas stays supported as the fallback.

The reason is the long term: the engine is moving to WebGL, and staying on the deprecated path would make every later
Phaser upgrade and every visual feature harder. Being on WebGL from now on is the cheaper way to keep that option open.

The decision rule written in #232 (switch only if a real GPU shows idle CPU within about 1.5x of Canvas, 60 fps on a
drag and a pinch, and a visible gain) was **not** met first. The owner chose to go ahead without it.

## Consequences

Accepted costs:

- Software-rendered WebGL uses far more CPU. Measured on Phaser 4.2.1 with `npm run probe:cpu` (idle solo race plus a few
  turns, 2 runs each): Canvas 2.1 s, WebGL 10.3 s, about 4.8x. That is the headless/CI class of machine. A real GPU is
  **not measured**.
- No automatic fallback: a machine with no GPU acceleration gets the slow path unless `?renderer=canvas` is used.

Kept as is:

- The e2e suite is pinned to Canvas (`VITE_RENDERER`, default `canvas` in `playwright.config.ts`) because its two pixel
  baselines are Canvas only and the smoke spec asserts a 2D context. `E2E_RENDERER=webgl` runs the whole suite on WebGL,
  and `e2e/webgl.spec.ts` plays a race on WebGL in any build. So the shipped default is covered by that one spec.
- WebGL-only features may now be used, but each must stay cheap on Canvas or be skipped there while Canvas exists.

Still open (tracked in #232):

- The real-GPU numbers: the `P` readout on Chromium, Firefox (X11, the #79 case) and an iPhone (the #58/#88 history).
- Texture size limits against `MAX_TRACK_TEXTURE_PIXELS` and the hidpi canvas, context loss, and `roundPixels`.
- What Phaser 4 gives (glow, shadow, vignette, bloom), tried one at a time.

## Revisit when

A real-GPU run shows a drag or pinch under 60 fps or an idle CPU far above Canvas, or players report the slow path. Then
either flip the default back (a one-line change in `src/main.ts` and `src/game/index.ts`, plus the test expectations)
or add a fallback to Canvas when the context is software-rendered or missing.
