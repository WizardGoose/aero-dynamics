/* build.js — "compile" the static site into _site/ for GitHub Pages.
   The site is plain HTML/JS so compilation means: syntax-check every script
   the site ships (standalone files + inline <script> blocks), verify the
   texture token manifest matches the textures/ folder, and emit the release
   files into _site/ — the artifact the Pages workflow publishes. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, '_site');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-build-'));

function log(msg) { console.log('[build] ' + msg); }
function fail(msg) { console.error('[build] FAIL: ' + msg); process.exit(1); }

/* 1. syntax-check standalone scripts */
for (const f of ['engine.js', 'engine-worker.js']) {
  execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'inherit' });
  log('checked ' + f);
}

/* 2. syntax-check every inline script the pages ship */
const inlineSrc = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
for (const f of ['index.html', 'wiki.html']) {
  const html = fs.readFileSync(path.join(ROOT, f), 'utf8');
  let i = 0;
  for (const m of html.matchAll(inlineSrc)) {
    const tmp = path.join(TMP, `inline-${f}-${i++}.js`);
    fs.writeFileSync(tmp, m[1]);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'inherit' });
  }
  if (i === 0) fail(f + ' has no inline script');
  log('checked ' + i + ' inline script(s) in ' + f);
}

/* 3. texture manifest must match the textures/ folder (sha256 per entry) */
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'textures.tokens.json'), 'utf8'));
const entries = manifest.textures || manifest;
if (!entries || typeof entries !== 'object') fail('textures.tokens.json has no recognizable entries');
const missing = [];
const walk = (dir) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) { walk(p); continue; }
    if (!name.endsWith('.png')) continue;
    const key = path.relative(ROOT, p).split(path.sep).join('/');
    if (!entries[key]) missing.push(key);
    else {
      const buf = fs.readFileSync(p);
      const sha = crypto.createHash('sha256').update(buf).digest('hex');
      if (entries[key].sha256 !== sha) fail(`texture checksum mismatch: ${key}`);
    }
  }
};
walk(path.join(ROOT, 'textures'));
if (missing.length) fail('textures missing from manifest: ' + missing.join(', '));
log('texture manifest verified (' + Object.keys(entries).length + ' entries)');

/* 4. emit the release into _site/ */
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const release = [
  'index.html', 'wiki.html', 'engine.js', 'engine-worker.js', 'three.min.js',
  'textures.tokens.json', 'COMPONENTS.md', 'README.md', 'textures/'
];
for (const f of release) {
  const src = path.join(ROOT, f);
  const dst = path.join(OUT, f);
  fs.cpSync(src, dst, { recursive: true });
}
const built = new Date().toISOString();
fs.writeFileSync(path.join(OUT, 'build.json'), JSON.stringify({
  name: 'aero-dynamics', builtAt: built,
  files: release.filter((f) => !f.endsWith('/')).length
}, null, 2));
log('site compiled to _site/ at ' + built);
