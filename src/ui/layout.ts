/**
 * The race screen's compact layout (a phone in landscape): the HUD becomes a top bar plus a standings drawer, and
 * the canvas hides its debug buttons. `src/style.css` uses the same media query; keep the two in step.
 */
export const COMPACT_HUD_QUERY = "(max-height: 500px)";

export function isCompactHud(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(COMPACT_HUD_QUERY).matches;
}

export type HudDock = "left" | "right" | "top";

/**
 * Space the DOM HUD takes from each side of the canvas, in canvas pixels. Each panel says where it docks with the
 * `--hud-dock` CSS property (style.css sets it per layout); panels without one (drawer, tooltip) float over the track.
 */
export function hudGutters(hud: Element, canvas: DOMRect, gap = 10): Record<HudDock, number> {
  const gutters = { left: 0, right: 0, top: 0 };
  for (const el of Array.from(hud.children)) {
    const dock = getComputedStyle(el).getPropertyValue("--hud-dock").trim();
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (dock === "left") gutters.left = Math.max(gutters.left, r.right - canvas.left + gap);
    else if (dock === "right") gutters.right = Math.max(gutters.right, canvas.right - r.left + gap);
    else if (dock === "top") gutters.top = Math.max(gutters.top, r.bottom - canvas.top + gap);
  }
  return gutters;
}
