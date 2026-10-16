// Plain SVG strings, no dependency. Every piece of text goes through `esc`.
export const COLORS = {
  bg: "#0b0f14",
  panel: "#111821",
  panelStroke: "#2a3642",
  text: "#e6edf3",
  muted: "#8fa3b5",
  lane: { 1: "#5aa9ff", 2: "#5fd38a", 3: "#f2c14e" } as Record<number, string>,
  sideways: "#ff9f43",
  forward: "#e6edf3",
  diagonal: "#5aa9ff",
  car: "#59636e",
  carStroke: "#a9b6c3",
  you: "#e5484d",
  target: "#ffe066",
  good: "#5fd38a",
  bad: "#ff6b6b"
};
const FONT = "ui-monospace, Menlo, Consolas, monospace";

export const esc = (s: string | number): string =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Numbers are rounded to one decimal so the file does not depend on float noise.
const n = (v: number): string => String(Math.round(v * 10) / 10);

export interface TextOpts {
  size?: number;
  bold?: boolean;
  anchor?: "start" | "middle" | "end";
  color?: string;
}
export function text(x: number, y: number, s: string | number, o: TextOpts = {}): string {
  const { size = 13, bold = false, anchor = "start", color = COLORS.muted } = o;
  return `<text x="${n(x)}" y="${n(y)}" fill="${color}" font-size="${size}" font-weight="${bold ? 700 : 400}" text-anchor="${anchor}" font-family="${FONT}">${esc(s)}</text>`;
}

export function rect(x: number, y: number, w: number, h: number, attrs: string): string {
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" ${attrs}/>`;
}

export function circle(x: number, y: number, r: number, attrs: string): string {
  return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" ${attrs}/>`;
}

/** A numbered step badge: a ring with the number inside. */
export function badge(x: number, y: number, label: number, color: string): string {
  return circle(x, y, 10, `fill="${COLORS.bg}" stroke="${color}" stroke-width="2"`) + text(x, y + 4, label, { size: 12, bold: true, anchor: "middle", color });
}

export function panel(x: number, y: number, w: number, h: number): string {
  return rect(x, y, w, h, `rx="10" fill="${COLORS.panel}" stroke="${COLORS.panelStroke}"`);
}

export function document(width: number, height: number, body: string[]): string {
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
    `<defs><pattern id="hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="7" height="7" fill="${COLORS.bg}"/><rect width="3" height="7" fill="${COLORS.diagonal}" opacity="0.5"/></pattern></defs>`,
    rect(0, 0, width, height, `fill="${COLORS.bg}"`),
    ...body,
    "</svg>",
    ""
  ].join("\n");
}
