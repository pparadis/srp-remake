// Renders public/icons/icon.svg into the PNG sizes the web app manifest and iOS need (npm run gen:icons).
// Uses Playwright's Chromium; set PW_CHROMIUM to a Chromium binary when the bundled one is not installed.
import { readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync(new URL("../public/icons/icon.svg", import.meta.url), "utf8");
const out = (name) => new URL(`../public/icons/${name}`, import.meta.url).pathname;
// maskable: the launcher may crop to a circle, so the art sits inside the middle 80% on the same background
const ICONS = [
  { name: "icon-192.png", size: 192, pad: 0 },
  { name: "icon-512.png", size: 512, pad: 0 },
  { name: "icon-maskable-512.png", size: 512, pad: 0.1 },
  { name: "apple-touch-icon.png", size: 180, pad: 0 }
];

const browser = await chromium.launch(
  process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {}
);
const page = await browser.newPage();
for (const { name, size, pad } of ICONS) {
  await page.setViewportSize({ width: size, height: size });
  const inset = Math.round(size * pad);
  await page.setContent(
    `<body style="margin:0;background:#0b0f14"><div style="padding:${inset}px;width:${size - 2 * inset}px;height:${size - 2 * inset}px">${svg.replace("<svg ", '<svg width="100%" height="100%" ')}</div></body>`
  );
  await page.screenshot({ path: out(name), omitBackground: false });
  console.log(`wrote public/icons/${name} (${size}x${size})`);
}
await browser.close();
