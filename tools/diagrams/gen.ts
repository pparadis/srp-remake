// npm run gen:diagrams: writes docs/img/*.svg from the engine, and a PNG next to each (some viewers do not render SVG).
// docs/img/diagrams.lock.json records which SVG (by hash) each PNG was rendered from: an unchanged diagram is not
// rendered again, and a test fails when an SVG changed without its PNG. Files in docs/img that no diagram makes are
// deleted. The PNG uses Playwright's Chromium (set PW_CHROMIUM to another binary); the SVG is what CI compares.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "@playwright/test";
import type { TrackData } from "../../src/game/types/track";
import { allDiagrams } from "./index";
import { hashText } from "./lock";

const track = JSON.parse(readFileSync(new URL("../../public/tracks/oval16_3lanes.json", import.meta.url), "utf8")) as TrackData;
const dir = new URL("../../docs/img/", import.meta.url);
const file = (name: string) => new URL(name, dir);
const LOCK = "diagrams.lock.json";
const lock: Record<string, string> = existsSync(file(LOCK)) ? JSON.parse(readFileSync(file(LOCK), "utf8")) : {};

const diagrams = allDiagrams(track);
const wanted = new Set([LOCK, ...[...diagrams.keys()].flatMap((n) => [n, n.replace(/\.svg$/, ".png")])]);
for (const name of readdirSync(dir)) {
  if (wanted.has(name)) continue;
  rmSync(file(name));
  console.log(`removed docs/img/${name} (no diagram makes it)`);
}

let browser: Browser | undefined;
let page: Page | undefined;
const next: Record<string, string> = {};
for (const [name, svg] of diagrams) {
  const png = name.replace(/\.svg$/, ".png");
  const hash = hashText(svg);
  next[png] = hash;
  writeFileSync(file(name), svg);
  if (lock[png] === hash && existsSync(file(png))) continue;
  browser ??= await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
  page ??= await browser.newPage();
  const [, w, h] = /viewBox="0 0 (\d+) (\d+)"/.exec(svg)!;
  await page.setViewportSize({ width: Number(w), height: Number(h) });
  await page.setContent(`<body style="margin:0">${svg}</body>`);
  await page.screenshot({ path: file(png).pathname });
  console.log(`wrote docs/img/${name} and ${png}`);
}
await browser?.close();
writeFileSync(file(LOCK), `${JSON.stringify(next, null, 2)}\n`);
