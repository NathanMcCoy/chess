// The bug button (site/js/bugreport.js, the same file as the admin site's) on the real server, in
// Chromium and WebKit. The admin site is played by the test (page.route), so nothing is sent anywhere:
// what's checked is that the page's own security policy lets the report out, that it's a plain
// request (no preflight) with credentials, and that a failed send is kept and sent later.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium, webkit } from 'playwright';
import { start } from '../server/server.mjs';

const ENDPOINT = 'https://admin.pacificfish.ca/api/bugs';
const PAGES = [['/', 'chess', '#board cg-board piece'], ['/hex', 'hex', '.hex-pieces piece']];
let server, base;
before(async () => { server = await start({ port: 0, host: '127.0.0.1' }); base = `http://127.0.0.1:${server.address().port}`; });
after(() => server.close());

test('the bug button is the same file as the admin site’s', { skip: !process.env.ADMIN_COPY && 'set ADMIN_COPY to compare' }, () => {
  assert.equal(readFileSync(new URL('../site/js/bugreport.js', import.meta.url), 'utf8'), readFileSync(process.env.ADMIN_COPY, 'utf8'));
});

for (const [name, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
  test(`bug button in ${name}`, async () => {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 760 } });
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (/Content.Security.Policy|Refused to/.test(m.text())) errors.push(m.text()); });
      const sent = [];
      let answer = 'ok';
      await page.route(ENDPOINT, async route => {
        const req = route.request();
        if (answer === 'down') return route.abort('connectionrefused');
        sent.push({ method: req.method(), type: req.headers()['content-type'], body: JSON.parse(req.postData()), extra: req.headers()['x-requested-with'] });
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true,"id":1}',
          headers: { 'Access-Control-Allow-Origin': base, 'Access-Control-Allow-Credentials': 'true' } });
      });

      // Visitors never see it
      await page.goto(base + '/');
      await page.locator(PAGES[0][2]).first().waitFor();
      await page.waitForTimeout(200);
      assert.equal(await page.locator('.bugreport-button').count(), 0, 'no button without ?bugs=on');

      // ?bugs=on turns it on in this browser, and comes out of the address
      await page.goto(base + '/?bugs=on');
      const btn = page.locator('button.bugreport-button');
      await btn.waitFor();
      assert.equal(new URL(page.url()).search, '', 'the address is tidied');

      for (const [path, app, ready] of PAGES) {
        await page.goto(base + path);
        await page.locator(ready).first().waitFor();
        await btn.click();
        const box = page.locator('dialog.bugreport-box');
        await box.waitFor();
        const src = await box.locator('img').getAttribute('src');
        assert.ok(src && src.startsWith('data:image/jpeg'), `${app}: a picture was taken (${await box.locator('p').first().innerText()})`);
        const colours = await page.evaluate(async src => {
          const img = new Image(); img.src = src; await img.decode();
          const c = document.createElement('canvas'); c.width = c.height = 48;
          const g = c.getContext('2d'); g.drawImage(img, 0, 0, 48, 48);
          const d = g.getImageData(0, 0, 48, 48).data, seen = new Set();
          for (let i = 0; i < d.length; i += 4) seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
          return seen.size;
        }, src);
        assert.ok(colours > 12, `${app}: the picture isn't blank (${colours} colours)`);
        if (process.env.SHOTS_DIR) {
          const { writeFileSync } = await import('node:fs');
          writeFileSync(`${process.env.SHOTS_DIR}/bug-${app}-${name}.jpg`, Buffer.from(src.split(',')[1], 'base64'));
        }
        await box.locator('textarea').fill(`${app} looks wrong`);
        await box.getByRole('button', { name: 'Save' }).click();
        await box.waitFor({ state: 'detached' });
        const r = sent.at(-1);
        assert.equal(r.body.app, app);
        assert.equal(r.body.note, `${app} looks wrong`);
        assert.match(r.body.image, /^data:image\/jpeg;base64,/);
        assert.match(r.type, /^text\/plain/, 'a plain request: no preflight');
        assert.equal(r.extra, undefined, 'no extra headers');
        assert.ok(r.body.context && r.body.context.includes('storage'), 'the saved game goes with it');
      }

      // The admin site can't be reached: kept on this device, a badge says so, and it goes next time
      answer = 'down';
      const before = sent.length;
      await btn.click();
      const box = page.locator('dialog.bugreport-box');
      await box.waitFor();
      await box.locator('textarea').fill('sent later');
      await box.getByRole('button', { name: 'Save' }).click();
      await box.getByText('kept on this device').waitFor();
      assert.ok(await box.getByRole('button', { name: 'Download it' }).isVisible(), 'it can be downloaded');
      await box.getByRole('button', { name: 'Close' }).click();
      assert.equal(await btn.locator('span').innerText(), '1');
      answer = 'ok';
      await page.reload();
      for (let i = 0; i < 100 && sent.length === before; i++) await page.waitForTimeout(100);   // it tries 2.5 s after loading
      assert.equal(await btn.locator('span').isVisible(), false, 'the badge goes');
      assert.equal(sent.length, before + 1, 'sent by itself after the reload');
      assert.equal(sent.at(-1).body.note, 'sent later');

      // ?bugs=off hides it again
      await page.goto(base + '/?bugs=off');
      await page.locator(PAGES[0][2]).first().waitFor();
      await page.waitForTimeout(200);
      assert.equal(await btn.count(), 0);
      assert.deepEqual(errors, [], 'no page errors and nothing refused by the security policy');
    } finally {
      await browser.close();
    }
  });
}
