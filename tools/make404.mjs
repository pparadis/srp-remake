// Writes dist/404.html, the SPA fallback Pages serves for any unknown path (a reload on a deep link).
// Pages has one 404.html per site (the root one), so a reload inside a PR preview (#96, /<repo>/pr-preview/pr-N/...)
// must load that preview's index.html, not production's. The page is a stub that fetches the right index.html and
// writes it over itself: the URL stays, so the router sees the deep link. It holds nothing else, because a copy of
// index.html would keep loading its own bundle beside the one written.
import { readFileSync, writeFileSync } from 'node:fs';

// shortcut: a synchronous XHR (deprecated but supported), so nothing else runs before the page is written; fine for
// a same-origin file this small, replace with a redirect carrying the path if browsers drop it.
export function build404(indexHtml) {
  // The build's base, from the manifest link ("/" or "/<repo>/").
  const base = indexHtml.match(/href="([^"]*)manifest\.webmanifest"/)?.[1] ?? '/';
  const script =
    `var m=location.pathname.match(/^.*\\/pr-preview\\/pr-\\d+\\//),x=new XMLHttpRequest();` +
    `x.open("GET",(m?m[0]:${JSON.stringify(base)})+"index.html",false);x.send();` +
    `if(x.status===200){document.open();document.write(x.responseText);document.close();}`;
  return `<!doctype html><html><head><meta charset="UTF-8" /></head><body><script>${script}</script></body></html>\n`;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  writeFileSync('dist/404.html', build404(readFileSync('dist/index.html', 'utf8')));
}
