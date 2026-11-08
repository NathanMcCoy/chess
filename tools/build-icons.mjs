// Makes the site's icon files from site/favicon.svg (the hexagon with the rook), by drawing it in
// Chromium (Playwright, already here for the tests) and saving each size:
//   site/favicon.ico          16, 32 and 48 px, for browsers and tools that only ask for /favicon.ico
//   site/apple-touch-icon.png 180 px on the page's dark background, for iPhone bookmarks and the
//                             Home Screen (iOS fills a see-through background with black)
// Run again after changing the SVG:
//   node tools/build-icons.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const site = new URL('../site/', import.meta.url);
const svg = readFileSync(new URL('favicon.svg', site), 'utf8');
const BG = '#0b1f2b';   // --bg in css/app.css

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
// size: the picture's width and height; pad: room around the icon; background: none = see-through
async function draw(size, { pad = 0, background = null } = {}) {
  const inner = size - 2 * pad;
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<!doctype html><html><body style="margin:0;background:${background || 'transparent'}">
    <img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}" width="${inner}" height="${inner}"
      style="display:block;margin:${pad}px"></body></html>`);
  await page.locator('img').evaluate(img => img.decode());
  return page.screenshot({ omitBackground: !background, clip: { x: 0, y: 0, width: size, height: size } });
}

// An ICO file is a short header, one 16-byte entry per size, then each size's PNG as it is
function ico(pngs) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let offset = head.length;
  pngs.forEach(({ size, png }, i) => {
    const e = 6 + 16 * i;
    head.writeUInt8(size >= 256 ? 0 : size, e); head.writeUInt8(size >= 256 ? 0 : size, e + 1);
    head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);   // 1 plane, 32 bits a pixel
    head.writeUInt32LE(png.length, e + 8); head.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([head, ...pngs.map(p => p.png)]);
}

const sizes = [];
for (const size of [16, 32, 48]) sizes.push({ size, png: await draw(size) });
writeFileSync(new URL('favicon.ico', site), ico(sizes));
writeFileSync(new URL('apple-touch-icon.png', site), await draw(180, { pad: 18, background: BG }));
await browser.close();
console.log('Wrote site/favicon.ico (16, 32, 48 px) and site/apple-touch-icon.png (180 px)');
