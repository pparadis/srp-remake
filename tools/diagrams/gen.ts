// npm run gen:diagrams: writes docs/img/*.svg from the engine, and a PNG next to each (some viewers do not render SVG).
// The PNG uses Playwright's Chromium (set PW_CHROMIUM to another binary); the SVG is what CI checks.
import { readFileSync, writeFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import type { TrackData } from "../../src/game/types/track";
import { allDiagrams } from "./index";

const track = JSON.parse(readFileSync(new URL("../../public/tracks/oval16_3lanes.json", import.meta.url), "utf8")) as TrackData;
const out = (name: string) => new URL(`../../docs/img/${name}`, import.meta.url);

const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage();
for (const [name, svg] of allDiagrams(track)) {
  writeFileSync(out(name), svg);
  const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
  await page.setViewportSize({ width: Number(w), height: Number(h) });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  const png = name.replace(/\.svg$/, ".png");
  await page.screenshot({ path: out(png).pathname });
  console.log(`wrote docs/img/${name} and ${png}`);
}
await browser.close();
