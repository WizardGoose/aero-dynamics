/* build.test.js — runs the Pages build in isolated repository copies. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RELEASE = ['index.html', 'wiki.html', 'engine.js', 'engine-worker.js', 'three.min.js',
  'textures.tokens.json', 'COMPONENTS.md', 'README.md'];

function copyRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aero-build-test-'));
  fs.cpSync(ROOT, dir, {
    recursive: true,
    filter: (source) => !['.git', '_site', 'node_modules'].includes(path.basename(source)),
  });
  return dir;
}
function runBuild(dir) {
  return spawnSync(process.execPath, ['scripts/build.js'], { cwd: dir, encoding: 'utf8' });
}
function remove(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('build: isolated happy path emits release files and reruns cleanly', () => {
  const dir = copyRepo();
  try {
    const first = runBuild(dir);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.match(first.stdout, /site compiled to _site/);
    const site = path.join(dir, '_site');
    for (const file of RELEASE) assert.ok(fs.existsSync(path.join(site, file)), file);
    const pngs = [];
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name.endsWith('.png')) pngs.push(p);
    });
    walk(path.join(site, 'textures'));
    assert.ok(pngs.length > 0);
    const build = JSON.parse(fs.readFileSync(path.join(site, 'build.json'), 'utf8'));
    assert.strictEqual(build.name, 'aero-dynamics');
    assert.ok(!Number.isNaN(Date.parse(build.builtAt)));
    assert.strictEqual(build.files, RELEASE.length);
    assert.strictEqual(runBuild(dir).status, 0);
  } finally {
    remove(dir);
  }
});

test('build: rejects a texture absent from the manifest', () => {
  const dir = copyRepo();
  try {
    fs.writeFileSync(path.join(dir, 'textures', 'missing.png'), 'new texture');
    const r = runBuild(dir);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /textures missing from manifest: textures\/missing\.png/);
  } finally { remove(dir); }
});

test('build: rejects a texture checksum mismatch', () => {
  const dir = copyRepo();
  try {
    let texture;
    const find = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, entry.name);
        if (entry.isDirectory()) find(p);
        else if (!texture && entry.name.endsWith('.png')) texture = p;
      }
    };
    find(path.join(dir, 'textures'));
    assert.ok(texture);
    fs.appendFileSync(texture, Buffer.from('changed'));
    const r = runBuild(dir);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /texture checksum mismatch/);
  } finally { remove(dir); }
});

test('build: rejects pages without inline scripts', () => {
  const dir = copyRepo();
  try {
    fs.writeFileSync(path.join(dir, 'wiki.html'), '<!doctype html>');
    const r = runBuild(dir);
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /wiki\.html has no inline script/);
  } finally { remove(dir); }
});

test('build: rejects standalone syntax errors', () => {
  const dir = copyRepo();
  try {
    fs.appendFileSync(path.join(dir, 'engine.js'), '\nthis is not valid javascript\n');
    const r = runBuild(dir);
    assert.notStrictEqual(r.status, 0);
  } finally { remove(dir); }
});

test('build: rejects an unreadable texture manifest', () => {
  const dir = copyRepo();
  try {
    fs.writeFileSync(path.join(dir, 'textures.tokens.json'), 'null');
    const r = runBuild(dir);
    assert.notStrictEqual(r.status, 0);
  } finally { remove(dir); }
});
