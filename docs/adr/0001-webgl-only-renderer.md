# ADR 0001: WebGL is the only renderer

- Status: accepted (2026-10-26), amended the same day: the Canvas fallback was removed (#237)
- Issue: #232, shipped in #233; the Canvas removal is #237
- Replaces: the earlier rule "Canvas on purpose" (AGENTS.md, "Race HUD")

## Context

The game used Phaser's Canvas renderer on purpose: it is a turn-based board, and _software_ WebGL cost about 14x the CPU
of Canvas (`tools/cpuProbe.mjs`, headless Chromium on SwiftShader). Phaser 4 (#230) now calls Canvas deprecated (still
there, no removal date; "WebGL for all new projects"), and every new Phaser 4 feature is WebGL only: filters (glow,
shadow, bloom, vignette), tint modes, lighting, GPU layers.

#233 added a switch (`?renderer=webgl|canvas`, one build, both renderers) and fixed what broke on WebGL (a hidden 0x0
container reaching the renderer; `keepGameSizeInSync` now ignores it).

## Decision

The game renders with WebGL only. WebGL became the default in #233, and the Canvas fallback was removed in #237: two
renderers meant testing both, and Canvas blocked every WebGL-only feature.

The reason is the long term: the engine is moving to WebGL, and staying on the deprecated path would make every later
Phaser upgrade and every visual feature harder. The owner chose to commit to WebGL now, without waiting for real-GPU
numbers: the decision rule written in #232 (switch only if a real GPU shows idle CPU within about 1.5x of Canvas, 60 fps
on a drag and a pinch, and a visible gain) was **not** met first.

The Canvas implementation stays reachable in git as the tag `canvas-renderer` (the last commit with
`?renderer=canvas`, the Canvas smoke leg in CI and `E2E_RENDERER`), for reference or to bring it back.

## Consequences

Accepted costs:

- Software-rendered WebGL uses far more CPU. Measured on Phaser 4.2.1 with `npm run probe:cpu` (idle solo race plus a few
  turns, 2 runs each): Canvas 2.1 s, WebGL 10.3 s, about 4.8x. That is the headless/CI class of machine. A real GPU is
  **not measured**.
- No fallback: a machine with no GPU acceleration gets the slow path, and a browser with no WebGL cannot run the game.

Testing: the e2e suite runs on WebGL, including the pixel baselines, which are checked on CI only. Software GL on CI is
deterministic, so it stays; a GPU runner is not worth it (no speed gain at the test build's 10 fps cap, and pixels would
vary by GPU and driver). `e2e/smoke.spec.ts` asserts the canvas holds a WebGL context.

Still open (tracked in #232):

- The real-GPU numbers: the `P` readout on Chromium, Firefox (X11, the #79 case) and an iPhone (the #58/#88 history).
- WebGL hardening: texture size limits against `MAX_TRACK_TEXTURE_PIXELS` and the hidpi canvas, and context loss.
- What Phaser 4 gives (glow, shadow, vignette, bloom), tried one at a time.

## Revisit when

A real-GPU run shows a drag or pinch under 60 fps or an idle CPU far above what a turn-based board needs, or players
report the slow path. Then either add a way to run without WebGL (starting from the `canvas-renderer` tag) or lower
the cost of the WebGL path.
