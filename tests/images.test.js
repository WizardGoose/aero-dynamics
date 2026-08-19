/* images.test.js — every texture converted to token variants (base64 + sha256),
   validated for structure and round-tripped byte-for-byte, then cross-checked
   against every texture path the site can reference. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const TEX = path.join(ROOT, 'textures');
const MANIFEST = path.join(ROOT, 'textures.tokens.json');

const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black'];
const WOODS = ['oak', 'spruce', 'birch', 'dark_oak', 'jungle', 'acacia', 'cherry', 'crimson', 'warped'];

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.png')) out.push(p);
  }
  return out;
}

function inspectPng(bytes) {
  /* minimal structural validation: signature, IHDR, IDAT, IEND */
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(bytes.length > 33, 'too small to be a PNG');
  assert.ok(bytes.subarray(0, 8).equals(sig), 'bad PNG signature');
  let off = 8, sawIHDR = false, sawIDAT = false, sawIEND = false, sawPLTE = false, ihdr = null;
  while (off + 8 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const tag = bytes.subarray(off + 4, off + 8).toString('ascii');
    const data = bytes.subarray(off + 8, off + 8 + len);
    const crc = bytes.readUInt32BE(off + 8 + len);
    assert.strictEqual(crc, crc32(bytes.subarray(off + 4, off + 8 + len)) >>> 0, `CRC mismatch in ${tag}`);
    if (tag === 'IHDR') {
      sawIHDR = true;
      ihdr = { w: data.readUInt32BE(0), h: data.readUInt32BE(4), depth: data[8], colorType: data[9] };
      assert.ok(ihdr.w > 0 && ihdr.w <= 4096 && ihdr.h > 0 && ihdr.h <= 4096, 'implausible dimensions');
      assert.ok(ihdr.colorType === 3 ? [1, 2, 4, 8].includes(ihdr.depth) : [8, 16].includes(ihdr.depth), 'unexpected bit depth');
      assert.ok([0, 2, 3, 4, 6].includes(ihdr.colorType), 'unexpected color type');
    }
    if (tag === 'IDAT') sawIDAT = true;
    if (tag === 'PLTE') sawPLTE = true;
    if (tag === 'IEND') { sawIEND = true; break; }
    off += 12 + len;
  }
  assert.ok(sawIHDR && sawIDAT && sawIEND, 'missing IHDR/IDAT/IEND');
  if (ihdr.colorType === 3) assert.ok(sawPLTE, 'indexed PNG missing PLTE');
  return ihdr;
}
/* zlib-based CRC32 (PNG chunk check) */
function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return crc ^ -1;
}

/* manifest generated once, at load — tests only read it */
const ALL_FILES = walk(TEX);
const MANIFEST_DATA = {};
for (const f of ALL_FILES) {
  const bytes = fs.readFileSync(f);
  const dims = inspectPng(bytes);
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  const base64 = bytes.toString('base64');
  MANIFEST_DATA[rel] = { sha256: crypto.createHash('sha256').update(bytes).digest('hex'), base64, width: dims.w, height: dims.h, bytes: bytes.length };
}
fs.writeFileSync(MANIFEST, JSON.stringify(MANIFEST_DATA, null, 1));

test('images: every texture is a valid PNG and token round-trips byte-for-byte', () => {
  assert.ok(ALL_FILES.length >= 80, `expected a healthy texture set, found ${ALL_FILES.length}`);
  for (const f of ALL_FILES) {
    const bytes = fs.readFileSync(f);
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    /* token round-trip: decode must reproduce the exact bytes */
    assert.ok(Buffer.from(MANIFEST_DATA[rel].base64, 'base64').equals(bytes), `base64 round-trip ${rel}`);
    assert.strictEqual(crypto.createHash('sha256').update(Buffer.from(MANIFEST_DATA[rel].base64, 'base64')).digest('hex'), MANIFEST_DATA[rel].sha256);
  }
  const back = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.deepStrictEqual(Object.keys(back).sort(), Object.keys(MANIFEST_DATA).sort());
});

test('images: every texture path the site can reference exists on disk', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const literal = [...html.matchAll(/textures\/[a-z0-9_/-]+\.png/g)].map((m) => m[0]);
  const dynamic = [];
  for (const c of COLORS) {
    dynamic.push(`textures/minecraft/${c}_wool.png`, `textures/aeronautics/envelope_${c}.png`, `textures/create/sail/canvas_${c}.png`);
  }
  for (const w of WOODS) {
    dynamic.push(`textures/minecraft/${w}_planks.png`);
    dynamic.push(`textures/minecraft/${w === 'crimson' ? 'crimson_stem' : w === 'warped' ? 'warped_stem' : w + '_log'}.png`);
  }
  const refs = new Set([...literal, ...dynamic]);
  assert.ok(refs.size >= 60, `expected many texture refs, got ${refs.size}`);
  for (const ref of refs) {
    assert.ok(fs.existsSync(path.join(ROOT, ref)), `referenced but missing on disk: ${ref}`);
  }
});

test('images: token manifest covers every file and all tokens are unique-per-file', () => {
  for (const f of ALL_FILES) {
    const rel = path.relative(ROOT, f).replace(/\\/g, '/');
    assert.ok(MANIFEST_DATA[rel], `manifest missing ${rel}`);
    assert.strictEqual(MANIFEST_DATA[rel].sha256, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
  }
  const shas = new Set(Object.values(MANIFEST_DATA).map((m) => m.sha256));
  assert.strictEqual(shas.size, ALL_FILES.length, 'no two files share a token (all byte-distinct)');
});

test('images: generated sail canvas textures carry the 16 color family', () => {
  for (const c of COLORS) {
    const p = path.join(ROOT, `textures/create/sail/canvas_${c}.png`);
    assert.ok(fs.existsSync(p), `canvas_${c}.png missing`);
    assert.strictEqual(inspectPng(fs.readFileSync(p)).w, 16);
  }
});
