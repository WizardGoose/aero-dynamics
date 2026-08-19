/* browser.test.js — real-Chromium smoke test (optional: needs the playwright
   package, e.g. NODE_PATH=<pw node_modules> node --test tests/browser.test.js).
   Skips automatically when playwright isn't resolvable, so `npm test` keeps
   working with zero dependencies. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');
let chromium = null;
try { chromium = require('playwright'); } catch (e) { chromium = null; }

const ROOT = path.join(__dirname, '..');

test('browser: real chromium — boots, generates every tab, exports, audits, no console errors', { skip: chromium ? false : 'playwright not installed (npm i playwright, then run with NODE_PATH)' }, async () => {
  /* serve the site */
  const port = 8391;
  const srv = spawn('python3', ['-m', 'http.server', String(port)], { cwd: ROOT, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 900));

  const browser = await chromium.chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('favicon')) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  try {
    /* 1. boot on the default balloon */
    await page.goto(`http://127.0.0.1:${port}/index.html`, { waitUntil: 'load' });
    await page.waitForTimeout(900);
    let blocks = await page.textContent('#st-blocks');
    assert.ok(blocks && blocks !== '—' && !blocks.startsWith('0 '), 'balloon generated: ' + blocks);
    assert.ok(await page.isVisible('#req'), 'requirements panel visible');

    /* 2. every generator tab renders a model */
    for (const tab of ['prop', 'wings', 'crystal', 'shapes', 'balloon']) {
      await page.click(`#tab-${tab}`);
      await page.waitForTimeout(500);
      const b2 = await page.textContent('#st-blocks');
      assert.ok(b2 && b2 !== '—', `${tab} generated: ${b2}`);
      const badge = await page.textContent('#st-badge');
      assert.ok(badge && badge.length > 2, `${tab} badge set`);
      if (tab !== 'lab') assert.ok(await page.isVisible('#req'), tab + ' requirements visible');
    }

    /* 3. crystal specifics: seeded determinism across a reload */
    await page.click('#tab-crystal');
    await page.waitForTimeout(400);
    const badge1 = await page.textContent('#st-badge');
    assert.ok(badge1.includes('FLIES'), 'default crystal flies: ' + badge1);
    const orient = await page.evaluate(() => {
      const r = window.state.result;
      return { orientation: r.orientation, lenX: r.maxX - r.minX, lenY: r.maxY - r.minY };
    });
    assert.strictEqual(orient.orientation, 'horizontal', 'shard lies horizontal');
    assert.ok(orient.lenX > orient.lenY, 'long axis runs along X');

    /* 4. share link round-trip inside the browser */
    const link = await page.evaluate(() => window.shareUrl ? window.shareUrl() : location.href);
    assert.ok(link.includes('#'), 'share link produced');
    await page.goto(link, { waitUntil: 'load' });
    await page.waitForTimeout(600);
    const tabAfter = await page.evaluate(() => window.state.tab);
    assert.strictEqual(tabAfter, 'crystal', 'shared crystal link routes back to crystal');

    /* 5. export a schematic in-page, then audit it in the lab */
    const full = await page.evaluate(() => {
      const r = window.state.result, p = window.state.params;
      const bytes = window.buildSchematic(r, p);
      return Array.from(bytes);
    });
    assert.ok(full.length > 500, 'schematic exported in browser (' + full.length + ' bytes)');
    /* the .litematic export too — captured before the lab clears the model */
    const lit = await page.evaluate(() => {
      const r = window.state.result, p = window.state.params;
      const bytes = window.buildLitematic(r, p, 'browser_shard');
      return Array.from(bytes);
    });
    assert.ok(lit.length > 400, 'litematic exported in browser (' + lit.length + ' bytes)');
    await page.click('#tab-lab');
    await page.waitForTimeout(300);
    await page.setInputFiles('#lab-file', { name: 'crystal.nbt', mimeType: 'application/octet-stream', buffer: Buffer.from(full) });
    await page.waitForTimeout(800);
    const labOut = await page.textContent('#lab-out');
    assert.ok(labOut.includes('minecraft:glass'), 'lab audited the export: ' + labOut.slice(0, 140));
    assert.ok(labOut.includes('no Create Aeronautics blocks'), 'pure shard — no drive blocks');

    /* 5c. .litematic export round-trips through the lab too (native format) */
    await page.setInputFiles('#lab-file', { name: 'crystal.litematic', mimeType: 'application/octet-stream', buffer: Buffer.from(lit) });
    await page.waitForTimeout(800);
    const litOut = await page.textContent('#lab-out');
    assert.ok(litOut.includes('minecraft:glass'), 'lab audited the litematic export: ' + litOut.slice(0, 140));
    assert.ok(litOut.includes('no Create Aeronautics blocks'), 'litematic shard has no drive blocks');

    /* 5b. crystal balance check: drop the ship back into the shard */
    await page.click('#tab-crystal');
    await page.waitForTimeout(400);
    await page.setInputFiles('#crystal-file', { name: 'ship.schem', mimeType: 'application/octet-stream', buffer: Buffer.from(full) });
    await page.waitForTimeout(700);
    const reqText = await page.textContent('#req-body');
    assert.ok(reqText.includes('Ship COM vs its own middle'), 'balance verdict in the requirements bar');
    assert.ok(reqText.includes('Combined craft COM'), 'combined craft COM shown');
    const clearBtn = await page.evaluate(() => window.clearCom && typeof window.clearCom === 'function');
    assert.ok(clearBtn, 'clear handler available');
    await page.evaluate(() => window.clearCom());
    await page.waitForTimeout(300);
    const reqAfter = await page.textContent('#req-body');
    assert.ok(!reqAfter.includes('Ship COM'), 'check cleared');

    /* 6. wiki links route */
    await page.goto(`http://127.0.0.1:${port}/wiki.html`, { waitUntil: 'load' });
    await page.waitForTimeout(300);
    await page.click('.golink');   /* first example link */
    await page.waitForTimeout(700);
    const routedTab = await page.evaluate(() => window.state.tab);
    assert.ok(['balloon', 'prop', 'wings', 'crystal', 'shapes'].includes(routedTab), 'wiki golink routed to ' + routedTab);

    /* 7. screenshots for the record */
    await page.click('#tab-crystal');
    await page.waitForTimeout(700);
    await page.screenshot({ path: '/tmp/aeroforge-crystal.png' });
    await page.click('#tab-balloon');
    await page.waitForTimeout(700);
    await page.screenshot({ path: '/tmp/aeroforge-balloon.png' });
  } finally {
    await browser.close();
    srv.kill('SIGKILL');
  }
  assert.deepStrictEqual(errors, [], 'no console/page errors: ' + errors.join(' | '));
});
