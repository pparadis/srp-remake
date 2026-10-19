// A stacked price bar: labelled segments, then "= total".
import { COLORS, rect, text } from './svg';

export interface Segment {
  label: string;
  value: number;
  color: string;
  // drawn hatched and dashed: a part of the price the code does not charge
  hatched?: boolean;
}

const UNIT = 56.5;

export function priceBar(
  x: number,
  y: number,
  segments: Segment[],
  total: number,
  totalColor: string
): string {
  const parts: string[] = [];
  let cx = x;
  for (const s of segments) {
    const w = Math.max(s.value * UNIT, 28) - 3;
    const attrs = s.hatched
      ? `rx="4" fill="url(#hatch)" stroke="${s.color}" stroke-dasharray="4 3"`
      : `rx="4" fill="${s.color}" `;
    parts.push(rect(cx, y, w, 36, attrs));
    parts.push(
      text(cx + w / 2, y + 23, s.label, { size: 12, bold: true, anchor: 'middle', color: '#fff' })
    );
    cx += w + 3;
  }
  parts.push(text(cx + 15, y + 25, `= ${total}`, { size: 18, bold: true, color: totalColor }));
  return parts.join('\n');
}

export const SEGMENT_COLORS = {
  forward: COLORS.car,
  sideways: COLORS.sideways,
  surcharge: COLORS.diagonal
};
