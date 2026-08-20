/* engine.test.js — node --test suite for engine.js */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

require('../engine.js');
const Gen = globalThis.Gen;

/* buildHotairProfile — replica of the UI's balloonshaper profile (index.html),
   kept here so the exact-preset claims are verified against the real engine. */
function buildHotairProfile(p) {
  const W = Math.min(p.lengthX, p.widthZ), H = p.heightY;
  const halfW = W / 2, yPeak = 0.62 * H, minR = halfW * 0.15;
  const Y = H + 2, pts = [];
  for (let py = 0; py < Y; py++) {
    const yn = py / (Y - 1), y = yn * H;
    let r;
    if (y <= yPeak) { const t = y / yPeak; r = minR + (halfW - minR) * Math.sin(t * Math.PI / 2); }
    else { const t2 = (y - yPeak) / (H - yPeak); r = halfW * Math.sqrt(Math.max(0, 1 - t2 * t2)); }
    pts.push({ y: yn, r: r / halfW });
  }
  return pts;
}
const perfect = (p) => Object.assign({ hollow: true, shell: 1, prune: true }, p, { profile: buildHotairProfile(p) });

/* ---------- balloon ---------- */
test('balloon: exact hot-air presets land exactly on their 500-multiples', () => {
  const presets = [
    [{ lengthX: 33, widthZ: 33, heightY: 38, profileScale: 1.031 }, 18000, 2894],
    [{ lengthX: 35, widthZ: 35, heightY: 40, profileScale: 0.896 }, 16000, 2766],
    [{ lengthX: 21, widthZ: 21, heightY: 26, profileScale: 1.175 }, 6000, 1438],
    [{ lengthX: 15, widthZ: 15, heightY: 20, profileScale: 0.832 }, 1000, 502],
  ];
  for (const [p, wantInt, wantWool] of presets) {
    const r = Gen.genBalloon(perfect(p));
    assert.strictEqual(r.interior, wantInt, `interior ${JSON.stringify(p)}`);
    assert.strictEqual(r.wool, wantWool, `wool ${JSON.stringify(p)}`);
    assert.strictEqual(r.interior % 500, 0);
  }
});

test('balloon: hollow vs solid, prune reduces blocks, shell adds blocks', () => {
  const base = { lengthX: 21, widthZ: 21, heightY: 26, shell: 1 };
  const hollow = Gen.genBalloon(base);
  const solid = Gen.genBalloon(Object.assign({}, base, { hollow: false }));
  const pruned = Gen.genBalloon(Object.assign({}, base, { prune: true }));
  const thick = Gen.genBalloon(Object.assign({}, base, { shell: 3 }));
  assert.ok(hollow.interior > 0);
  assert.strictEqual(solid.interior, 0);
  assert.strictEqual(solid.count, solid.solid);
  assert.ok(pruned.count <= hollow.count, 'pruned <= unpruned');
  assert.ok(thick.count > hollow.count, 'thicker shell = more blocks');
  assert.strictEqual(hollow.count, hollow.wool + hollow.logs + hollow.planks);
});

test('balloon: burner rule + requirement math (mathFor)', () => {
  const r = Gen.genBalloon(perfect({ lengthX: 21, widthZ: 21, heightY: 26, profileScale: 1.175 }));
  const m = Gen.mathFor(r, 1, 0);
  assert.strictEqual(m.burners, r.interior / 500);
  assert.strictEqual(m.covered, m.burners * 500);
  assert.strictEqual(m.waste, 0);
  assert.strictEqual(m.lift, r.interior * 1.5);
  assert.strictEqual(m.mass, r.count + m.burners);
  assert.ok(m.flies);
  assert.ok(m.volWool > 3, 'big balloon is volume-efficient');
  const m2 = Gen.mathFor(r, 10, 10000);
  assert.strictEqual(m2.mass, (r.count + m2.burners) * 10 + 10000);
  assert.ok(!m2.flies);
});

test('balloon: min/max bounds cover every emitted block', () => {
  const r = Gen.genBalloon(perfect({ lengthX: 21, widthZ: 21, heightY: 26, profileScale: 1.175 }));
  for (let i = 0; i < r.count; i++) {
    const x = r.positions[i * 3], y = r.positions[i * 3 + 1], z = r.positions[i * 3 + 2];
    assert.ok(x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY && z >= r.minZ && z <= r.maxZ);
  }
});

/* ---------- propeller ---------- */
test('prop: counts, blades, material and requirement math (propMath)', () => {
  const r = Gen.genProp({ blades: 4, length: 10, rootChord: 3, tipChord: 1, swept: true, bladeMaterial: 'wool' });
  assert.ok(r.count > 20);
  assert.strictEqual(r.wool, r.count);
  const pm = Gen.propMath({ blades: 4, length: 10, bladeMaterial: 'wool' }, r);
  assert.strictEqual(pm.blades, 4);
  assert.strictEqual(pm.total, r.count);
  assert.ok(Math.abs(pm.perBlade - (r.count - 1) / 4) < 1e-9);
  assert.strictEqual(pm.discDia, 20);
  assert.strictEqual(pm.bearings, 1);
  const sail = Gen.genProp({ blades: 3, length: 15, bladeMaterial: 'sail' });
  assert.strictEqual(sail.wool, 0);
});

test('prop: sail material changes type, curved vs linear differ, more blades = more blocks', () => {
  const linear = Gen.genProp({ blades: 4, length: 12, airfoilShape: 'linear', bladeMaterial: 'wool' });
  const curved = Gen.genProp({ blades: 4, length: 12, airfoilShape: 'curved', bladeMaterial: 'wool' });
  assert.notStrictEqual(linear.count, curved.count);
  const f2 = Gen.genProp({ blades: 2, length: 12, bladeMaterial: 'wool' });
  const f4 = Gen.genProp({ blades: 4, length: 12, bladeMaterial: 'wool' });
  assert.ok(f4.count > f2.count);
  const sail = Gen.genProp({ blades: 4, length: 12, bladeMaterial: 'sail' });
  for (let i = 0; i < sail.count; i++) assert.strictEqual(sail.types[i], 9 /* SAIL */);
});

/* ---------- wings ---------- */
test('prop: exactly one center hub block, whatever the blade parameters', () => {
  for (const p of [
    { blades: 4, length: 10, rootChord: 3, tipChord: 1 },
    { blades: 3, length: 14, rootChord: 6, tipChord: 2, swept: true, sweepDegrees: 40 },
    { blades: 12, length: 20, rootChord: 2, tipChord: 0, airfoilShape: 'curved' },
    { blades: 2, length: 6, rootChord: 1, tipChord: 1, airfoilShape: 'linear' },
  ]) {
    const r = Gen.genProp(p);
    let hub = 0;
    for (let i = 0; i < r.count; i++) {
      if (r.positions[i * 3] === r.center[0] && r.positions[i * 3 + 1] === r.center[1] && r.positions[i * 3 + 2] === r.center[2]) hub++;
    }
    assert.strictEqual(hub, 1, `one hub block for ${JSON.stringify(p)}`);
    /* no other cell sits closer than 1 block to the hub */
    for (let i = 0; i < r.count; i++) {
      const dx = r.positions[i * 3] - r.center[0], dz = r.positions[i * 3 + 2] - r.center[2];
      if (dx === 0 && dz === 0) continue;
      assert.ok(dx * dx + dz * dz >= 1, `blade root clears the hub for ${JSON.stringify(p)}`);
    }
  }
});

test('prop: forceCenter keeps the root row — no blade row is cleared', () => {
  /* regression: the old hub pass tested the packed array's constant middle
     coordinate for horizontal props, wiping the whole root row of the first
     blade (and any other cell sharing a 0 coordinate). The row must keep
     all of its blocks with forceCenter on. */
  for (const p of [
    { blades: 4, length: 10, rootChord: 3, tipChord: 1, forceCenter: true },
    { blades: 3, length: 14, rootChord: 6, tipChord: 2, swept: true, sweepDegrees: 40, forceCenter: true },
    { blades: 2, length: 12, rootChord: 2, tipChord: 2, airfoilShape: 'curved', forceCenter: true },
  ]) {
    const r = Gen.genProp(p);
    let hub = 0, rowCells = 0;
    for (let i = 0; i < r.count; i++) {
      const dx = r.positions[i * 3] - r.center[0], dz = r.positions[i * 3 + 2] - r.center[2];
      if (dx === 0 && dz === 0) hub++;
      if (dx === 0 && dz !== 0) rowCells++;   /* root row of the first blade */
    }
    assert.strictEqual(hub, 1, `one hub block for ${JSON.stringify(p)}`);
    assert.ok(rowCells > 0, `root row keeps its blocks for ${JSON.stringify(p)} (got ${rowCells})`);
  }
});

test('prop: forceCenter on/off both generate, hub is a single block either way', () => {
  const on = Gen.genProp({ blades: 4, length: 10, rootChord: 3, tipChord: 1, forceCenter: true });
  const off = Gen.genProp({ blades: 4, length: 10, rootChord: 3, tipChord: 1, forceCenter: false });
  const hubCount = (r) => {
    let n = 0;
    for (let i = 0; i < r.count; i++) {
      if (r.positions[i * 3] === r.center[0] && r.positions[i * 3 + 1] === r.center[1] && r.positions[i * 3 + 2] === r.center[2]) n++;
    }
    return n;
  };
  assert.strictEqual(hubCount(on), 1);
  assert.strictEqual(hubCount(off), 1);
  assert.strictEqual(on.count, off.count, 'deduped hub means identical fills');
});

test('crystal: zero-valued sliders are honored (no || default swallowing)', () => {
  /* regression: p.crackCount || 2 etc. turned slider 0 back into the default */
  const base = Gen.genCrystal({});
  const clean = Gen.genCrystal({ crackCount: 0, inclusionCount: 0, jitter: 0, leanX: 0, leanZ: 0, midBand: 0, seed: 0, hollow: true });
  assert.strictEqual(clean.cracksMade, 0, 'crackCount 0 removes every crack');
  assert.strictEqual(clean.inclusionTotal, 0, 'inclusionCount 0 removes every inclusion');
  assert.ok(clean.count !== base.count, 'zeroed imperfections change the shard');
  assert.strictEqual(Gen.genCrystal({ crackCount: 0 }).cracksMade, 0);
  assert.strictEqual(Gen.genCrystal({ inclusionCount: 0 }).inclusionTotal, 0);   /* legacy raw count still accepted */
  assert.strictEqual(Gen.genCrystal({ inclusionPct: 0 }).inclusionTotal, 0);     /* 0% removes every inclusion */
  /* percentages scale with the hull: same pct, bigger crystal, more glow blocks */
  const small = Gen.genCrystal({ heightY: 20, baseDiagX: 8, baseDiagZ: 6, jitter: 0, crackCount: 0, inclusionPct: 5 });
  const big = Gen.genCrystal({ heightY: 60, baseDiagX: 24, baseDiagZ: 18, jitter: 0, crackCount: 0, inclusionPct: 5 });
  assert.ok(big.inclusionTotal > small.inclusionTotal, '5% of a big hull > 5% of a small hull');
  assert.ok(big.inclusionTotal / big.count > 0.02 && big.inclusionTotal / big.count < 0.12, 'inclusion share lands near 5%');
  /* seed 0 is a valid seed */
  const s0a = Gen.genCrystal({ seed: 0 });
  const s0b = Gen.genCrystal({ seed: 0 });
  assert.deepStrictEqual(Array.from(s0a.positions), Array.from(s0b.positions), 'seed 0 deterministic');
});

test('prop/wings: zero-valued sliders are honored', () => {
  const p0 = Gen.genProp({ blades: 2, length: 8, rootChord: 4, tipChord: 0 });
  const p1 = Gen.genProp({ blades: 2, length: 8, rootChord: 4, tipChord: 1 });
  assert.ok(p0.count < p1.count, 'tipChord 0 yields a narrower blade than 1');
  const w0 = Gen.genWings({ halfSpan: 10, rootChord: 6, sweepBlocks: 0 });
  const w3 = Gen.genWings({ halfSpan: 10, rootChord: 6, sweepBlocks: 3 });
  assert.notStrictEqual(w0.count, w3.count, 'sweepBlocks 0 vs 3 differ');
});

test('wings: area, mirror, delta tip, block choice', () => {
  const w = Gen.genWings({ halfSpan: 12, rootChord: 6, tipChord: 2, sweepBlocks: 3, mirror: true, planform: 'tapered' });
  assert.ok(w.area > 0);
  assert.strictEqual(w.area, w.count);
  const one = Gen.genWings({ halfSpan: 12, rootChord: 6, tipChord: 2, mirror: false });
  assert.ok(one.area < w.area);
  const delta = Gen.genWings({ halfSpan: 14, rootChord: 12, planform: 'delta', mirror: false });
  assert.strictEqual(delta.maxX - delta.minX + 1, 14);
  const w12 = Gen.genWings({ halfSpan: 8, wingBlock: 'copycat_wing_12', mirror: false });
  assert.strictEqual(w12.wingBlock, 'copycat_wing_12');
});

/* ---------- crystal ---------- */
test('crystal: default flies, hollow with interior, deterministic per seed', () => {
  const r = Gen.genCrystal({});
  assert.ok(r.interior > 0, 'hollow crystal has a cavity');
  assert.ok(r.crystalCount > 0);
  assert.strictEqual(r.burners, Math.ceil(r.interior / 500));
  assert.ok(r.net > 0, `default crystal flies (net ${r.net})`);
  const r2 = Gen.genCrystal({});
  assert.strictEqual(r.count, r2.count);
  assert.deepStrictEqual(Array.from(r.positions), Array.from(r2.positions));
  assert.deepStrictEqual(Array.from(r.types), Array.from(r2.types));
});

test('crystal: seed changes the imperfections; structure invariants hold', () => {
  const a = Gen.genCrystal({ seed: 1337, jitter: 0.2, twistDeg: 60, crackCount: 5, inclusionCount: 5 });
  const b = Gen.genCrystal({ seed: 42, jitter: 0.2, twistDeg: 60, crackCount: 5, inclusionCount: 5 });
  const differs = a.count !== b.count ||
    Array.from(a.positions).some((v, i) => v !== b.positions[i]);
  assert.ok(differs, 'different seed => different crystal');
  /* interior + hull = solid (cracks remove hull, inclusions only recolor it) */
  assert.strictEqual(a.interior + a.crystalCount + a.inclusionTotal, a.solid);
  assert.ok(a.interior > 0);
  assert.ok(a.cracksMade <= 5);
  assert.ok(a.inclusionTotal >= 1 && a.inclusionTotal <= 40);
  /* every emitted block inside bbox */
  for (let i = 0; i < a.count; i++) {
    assert.ok(a.positions[i * 3] >= a.minX && a.positions[i * 3] <= a.maxX);
    assert.ok(a.positions[i * 3 + 1] >= a.minY && a.positions[i * 3 + 1] <= a.maxY);
    assert.ok(a.positions[i * 3 + 2] >= a.minZ && a.positions[i * 3 + 2] <= a.maxZ);
  }
});

test('crystal: double-terminated — a single point block at BOTH ends, no wood', () => {
  const r = Gen.genCrystal({ orientation: 'vertical', jitter: 0, topCrop: 0, cracks: 0, inclusionCount: 0, heightY: 40, baseDiagX: 16, baseDiagZ: 12, leanX: 0, leanZ: 0 });
  const byY = {};
  for (let i = 0; i < r.count; i++) {
    const y = r.positions[i * 3 + 1];
    (byY[y] = byY[y] || []).push(i);
  }
  const ys = Object.keys(byY).map(Number).sort((a, b) => a - b);
  assert.strictEqual(byY[ys[0]].length, 1, 'bottom tip is a single block');
  assert.strictEqual(byY[ys[ys.length - 1]].length, 1, 'top tip is a single block');
  assert.strictEqual(r.planks, 0, 'no deck wood');
  assert.strictEqual(r.count, r.crystalCount + r.inclusionTotal, 'pure shard');
  assert.ok(r.crystalCount > 200, 'solid shard body');
  /* the widest band sits at midY */
  const mid = Math.round(r.heightY * r.midY);
  const widest = ys.reduce((a, y) => (byY[y].length > byY[a].length ? y : a), ys[0]);
  assert.ok(Math.abs(widest - mid) <= 5, `widest layer near midY (${widest} vs ${mid})`);
});

test('crystal: lies horizontal by default — long axis X, tips at both ends', () => {
  const r = Gen.genCrystal({ jitter: 0, crackCount: 0, inclusionCount: 0, leanX: 0, leanZ: 0 });
  assert.strictEqual(r.orientation, 'horizontal');
  const lenX = r.maxX - r.minX, lenY = r.maxY - r.minY, lenZ = r.maxZ - r.minZ;
  assert.ok(lenX > lenY && lenX > lenZ, `long axis is X: ${lenX} vs ${lenY}/${lenZ}`);
  const byX = {};
  for (let i = 0; i < r.count; i++) {
    const x = r.positions[i * 3];
    (byX[x] = byX[x] || []).push(i);
  }
  const xs = Object.keys(byX).map(Number).sort((a, b) => a - b);
  assert.strictEqual(byX[xs[0]].length, 1, 'tail tip is a single block');
  assert.strictEqual(byX[xs[xs.length - 1]].length, 1, 'nose tip is a single block');
  assert.strictEqual(r.minY, 0, 'sits on the grid');
  const up = Gen.genCrystal({ orientation: 'vertical', jitter: 0, crackCount: 0, inclusionCount: 0, leanX: 0, leanZ: 0 });
  assert.strictEqual(up.orientation, 'vertical');
  assert.ok(up.maxY - up.minY > up.maxX - up.minX, 'upright shard is tall');
  assert.strictEqual(up.count, r.count, 'orientation only swaps coordinates');
});

test('crystal: nose dip drops the nose by the chosen number of blocks', () => {
  const r = Gen.genCrystal({ jitter: 0, crackCount: 0, inclusionCount: 0 });   /* default: dip 1 */
  const cells = [];
  for (let i = 0; i < r.count; i++) cells.push([r.positions[i * 3], r.positions[i * 3 + 1], r.positions[i * 3 + 2]]);
  const byX = {};
  for (const c of cells) (byX[c[0]] = byX[c[0]] || []).push(c);
  const xs = Object.keys(byX).map(Number).sort((a, b) => a - b);
  const tailY = byX[xs[0]][0][1], noseY = byX[xs[xs.length - 1]][0][1];
  assert.strictEqual(tailY - noseY, 1, `default nose dip is 1 block (${tailY} → ${noseY})`);
  const dip4 = Gen.genCrystal({ leanX: 4, jitter: 0, crackCount: 0, inclusionCount: 0 });
  const byX2 = {};
  for (let i = 0; i < dip4.count; i++) {
    const x = dip4.positions[i * 3];
    (byX2[x] = byX2[x] || []).push(dip4.positions[i * 3 + 1]);
  }
  const xs2 = Object.keys(byX2).map(Number).sort((a, b) => a - b);
  assert.strictEqual(byX2[xs2[0]][0] - byX2[xs2[xs2.length - 1]][0], 4, '4-block nose dip');
  /* upright: the dip becomes a +X slant of the top tip */
  const up = Gen.genCrystal({ orientation: 'vertical', leanX: 3, jitter: 0, crackCount: 0, inclusionCount: 0 });
  const byY = {};
  for (let i = 0; i < up.count; i++) {
    const y = up.positions[i * 3 + 1];
    (byY[y] = byY[y] || []).push(up.positions[i * 3]);
  }
  const ys = Object.keys(byY).map(Number).sort((a, b) => a - b);
  assert.strictEqual(byY[ys[ys.length - 1]][0] - byY[ys[0]][0], 3, 'upright slant of 3 blocks');
});

test('crystal: odd/even center forces the widest cross-section', () => {
  const odd = Gen.genCrystal({ centerMode: 'odd', baseDiagX: 16, baseDiagZ: 10, jitter: 0 });
  assert.strictEqual(odd.centerMode, 'odd');
  assert.strictEqual(odd.baseDiagX % 2, 1);
  assert.strictEqual(odd.baseDiagZ % 2, 1);
  const even = Gen.genCrystal({ centerMode: 'even', baseDiagX: 16, baseDiagZ: 10, jitter: 0 });
  assert.strictEqual(even.centerMode, 'even');
  assert.strictEqual(even.baseDiagX % 2, 0);
  assert.strictEqual(even.baseDiagZ % 2, 0);
  assert.strictEqual(Gen.genCrystal({}).centerMode, 'odd', 'odd is the default');
});

test('crystal: the middle band bulges the shard; truncated top cuts the tip', () => {
  const slim = Gen.genCrystal({ midBand: 0, inclusionCount: 0, crackCount: 0 });
  const banded = Gen.genCrystal({ midBand: 0.4, inclusionCount: 0, crackCount: 0 });
  assert.ok(banded.crystalCount > slim.crystalCount, 'band adds prism volume');
  const cut = Gen.genCrystal({ orientation: 'vertical', topCrop: 0.3, jitter: 0, inclusionCount: 0, crackCount: 0, leanX: 0, leanZ: 0 });
  const byY = {};
  for (let i = 0; i < cut.count; i++) (byY[cut.positions[i * 3 + 1]] = (byY[cut.positions[i * 3 + 1]] || 0) + 1);
  const top = Math.max(...Object.keys(byY).map(Number));
  assert.ok(byY[top] > 1, 'truncated top has a flat cap, not a point');
});

test('crystal: solid mode has no cavity; extreme imperfection params stay in bounds', () => {
  const solid = Gen.genCrystal({ hollow: false });
  assert.strictEqual(solid.interior, 0);
  const wild = Gen.genCrystal({ facets: 6, jitter: 0.4, twistDeg: 180, leanX: 100, leanZ: 60, asym: 0.5, topCrop: 0.5, midBand: 0.3, crackCount: 20, inclusionCount: 20, seed: 9999 });
  assert.ok(wild.count > 0);
  assert.ok(wild.cracksMade <= 20);
  assert.ok(wild.maxX - wild.minX + 1 <= 100 + 100 + 2 * 42, 'bbox within theoretical max');
});

test('crystal: net lift = lift - mass, matches mathFor on interior', () => {
  const r = Gen.genCrystal({ blockMass: 2, payload: 500 });
  assert.strictEqual(r.lift, r.interior * 1.5);
  assert.strictEqual(r.mass, (r.count + r.burners) * 2 + 500);
  assert.strictEqual(r.net, r.lift - r.mass);
});

test('crystal: airtight — exactly one sealed cavity, no stray air gaps', () => {
  /* rebuild the emitted hull and flood-fill air from the outside bbox,
     6-connected (the game's face-tight seal semantics) */
  const analyze = (r) => {
    const X = r.maxX - r.minX + 1, Y = r.maxY - r.minY + 1, Z = r.maxZ - r.minZ + 1;
    const YZ = Y * Z;
    const grid = new Uint8Array(X * Y * Z);
    for (let i = 0; i < r.count; i++) {
      const x = r.positions[i * 3] - r.minX, y = r.positions[i * 3 + 1] - r.minY, z = r.positions[i * 3 + 2] - r.minZ;
      grid[x * YZ + y * Z + z] = 1;
    }
    const mark = new Int32Array(X * Y * Z);
    const q = [];
    const seed = (x, y, z) => { const i = x * YZ + y * Z + z; if (!grid[i] && !mark[i]) { mark[i] = 1; q.push(i); } };
    for (let x = 0; x < X; x++) for (let y = 0; y < Y; y++) { seed(x, y, 0); seed(x, y, Z - 1); }
    for (let y = 0; y < Y; y++) for (let z = 0; z < Z; z++) { seed(0, y, z); seed(X - 1, y, z); }
    for (let x = 0; x < X; x++) for (let z = 0; z < Z; z++) { seed(x, 0, z); seed(x, Y - 1, z); }
    while (q.length) {
      const i = q.pop();
      const x = (i / YZ) | 0, rem = i - x * YZ, y = (rem / Z) | 0, z = rem - y * Z;
      const nb = [];
      if (x > 0) nb.push(i - YZ); if (x < X - 1) nb.push(i + YZ);
      if (y > 0) nb.push(i - Z); if (y < Y - 1) nb.push(i + Z);
      if (z > 0) nb.push(i - 1); if (z < Z - 1) nb.push(i + 1);
      for (const n of nb) if (!grid[n] && !mark[n]) { mark[n] = 1; q.push(n); }
    }
    const comps = [];
    let nextId = 2;
    for (let i = 0; i < X * Y * Z; i++) {
      if (grid[i] || mark[i]) continue;
      const id = nextId++, qq = [i];
      mark[i] = id;
      let cnt = 0;
      while (qq.length) {
        const c = qq.pop(); cnt++;
        const x = (c / YZ) | 0, rm = c - x * YZ, y = (rm / Z) | 0, z = rm - y * Z;
        const nb = [];
        if (x > 0) nb.push(c - YZ); if (x < X - 1) nb.push(c + YZ);
        if (y > 0) nb.push(c - Z); if (y < Y - 1) nb.push(c + Z);
        if (z > 0) nb.push(c - 1); if (z < Z - 1) nb.push(c + 1);
        for (const n of nb) if (!grid[n] && !mark[n]) { mark[n] = id; qq.push(n); }
      }
      comps.push(cnt);
    }
    return comps;
  };
  /* a sweep of imperfection-heavy configs: exactly ONE enclosed air region
     (the cavity) — no leaks, no pockets, no stranded chambers. Cracks must
     still be carved (they are grooves now, not vents). */
  const cases = [
    {},
    { jitter: 0, crackCount: 0, inclusionCount: 0, leanX: 0, leanZ: 0 },
    { jitter: 0.4, twistDeg: 90, leanZ: 2, asym: 0.2, topCrop: 0.2, seed: 7 },
    { jitter: 0.2, twistDeg: 60, crackCount: 8, leanX: 3, leanZ: 1, asym: 0.15, seed: 77, heightY: 40, baseDiagX: 24, baseDiagZ: 16, facets: 6, topCrop: 0.25 },
    { orientation: 'vertical', jitter: 0.3, twistDeg: 120, leanX: 4, crackCount: 10, seed: 999, heightY: 36, baseDiagX: 14, baseDiagZ: 10, centerMode: 'even' },
    { shell: 2, jitter: 0.4, crackCount: 6, twistDeg: 30, leanX: 5, seed: 13 },
    { shell: 3, jitter: 0.4, crackCount: 12, twistDeg: 90, leanX: 5, leanZ: 3, asym: 0.3, seed: 42 },
  ];
  for (const p of cases) {
    const r = Gen.genCrystal(p);
    const comps = analyze(r);
    assert.strictEqual(comps.length, 1, `one sealed air region for ${JSON.stringify(p)}: ${JSON.stringify(comps)}`);
    assert.ok(comps[0] > 10, `the sealed region is the cavity: ${JSON.stringify(comps)}`);
  }
  /* cracks still carve real grooves (they just cannot vent the cavity) */
  assert.strictEqual(Gen.genCrystal({ crackCount: 8, seed: 77 }).cracksMade, 8);
});

test('crystal: inclusion variants — glass patches with their own shares and type codes', () => {
  const r = Gen.genCrystal({ crackCount: 0, seed: 9, inclusions: [
    { material: 'tinted_glass', pct: 8 },
    { material: 'white_stained_glass', pct: 6 },
    { material: 'cyan_stained_glass', pct: 4 },
  ] });
  assert.strictEqual(r.inclusions.length, 3);
  assert.strictEqual(r.inclusions[0].material, 'tinted_glass');
  const hull = r.crystalCount + r.inclusionTotal;
  for (const v of r.inclusions) {
    assert.ok(Math.abs(v.count / hull - v.pct / 100) < 0.05, `${v.material} lands near its ${v.pct}% share (${v.count}/${hull})`);
  }
  /* distinct type codes per variant: 20 crystal, 21/28/29 inclusions —
     never colliding with the feature band 22..27 */
  const types = new Set(Array.from(r.types));
  assert.ok(types.has(20) && types.has(21) && types.has(28) && types.has(29), JSON.stringify([...types]));
  assert.strictEqual(r.inclusionTotal, r.inclusions.reduce((a, v) => a + v.count, 0));
  assert.strictEqual(r.interior + r.crystalCount + r.inclusionTotal, r.solid);
  /* legacy single-variant path still works, including plain glass */
  const g = Gen.genCrystal({ inclusionMaterial: 'glass', inclusionPct: 4, crackCount: 0, seed: 1 });
  assert.strictEqual(g.inclusions.length, 1);
  assert.strictEqual(g.inclusions[0].material, 'glass');
  assert.ok(g.inclusionTotal > 0);
  /* a zero-share variant places nothing */
  assert.strictEqual(Gen.genCrystal({ inclusions: [{ material: 'glass', pct: 0 }], crackCount: 0 }).inclusionTotal, 0);
});

test('crystal: the hull is ONE face-connected piece — nothing floats loose', () => {
  /* in game the assembler only joins face-connected blocks, so the emitted
     hull must be a single 6-connected component: the end points (and every
     other block) stay attached to the ship */
  const components = (r) => {
    const X = r.maxX - r.minX + 1, Y = r.maxY - r.minY + 1, Z = r.maxZ - r.minZ + 1;
    const YZ = Y * Z;
    const grid = new Uint8Array(X * Y * Z);
    for (let i = 0; i < r.count; i++) {
      const x = r.positions[i * 3] - r.minX, y = r.positions[i * 3 + 1] - r.minY, z = r.positions[i * 3 + 2] - r.minZ;
      grid[x * YZ + y * Z + z] = 1;
    }
    const sid = new Int32Array(X * Y * Z);
    const sizes = [];
    let nc = 0;
    for (let i = 0; i < X * Y * Z; i++) {
      if (!grid[i] || sid[i]) continue;
      nc++;
      const qq = [i];
      sid[i] = nc;
      let c = 0;
      while (qq.length) {
        const k = qq.pop(); c++;
        const x = (k / YZ) | 0, rem = k - x * YZ, y = (rem / Z) | 0, z = rem - y * Z;
        const nb = [];
        if (x > 0) nb.push(k - YZ); if (x < X - 1) nb.push(k + YZ);
        if (y > 0) nb.push(k - Z); if (y < Y - 1) nb.push(k + Z);
        if (z > 0) nb.push(k - 1); if (z < Z - 1) nb.push(k + 1);
        for (const n of nb) if (grid[n] && !sid[n]) { sid[n] = nc; qq.push(n); }
      }
      sizes.push(c);
    }
    return sizes;
  };
  for (const p of [
    {},
    { heightY: 127 },
    { heightY: 127, seed: 42 },
    { heightY: 127, crackCount: 8, seed: 77 },
    { jitter: 0.4, twistDeg: 90, leanZ: 2, seed: 7 },
    { orientation: 'vertical', jitter: 0.3, twistDeg: 120, leanX: 4, crackCount: 10, seed: 999, heightY: 36, baseDiagX: 14, baseDiagZ: 10, centerMode: 'even' },
    { shell: 3, jitter: 0.4, crackCount: 12, twistDeg: 90, leanX: 5, leanZ: 3, asym: 0.3, seed: 42 },
  ]) {
    const r = Gen.genCrystal(p);
    const comps = components(r);
    assert.strictEqual(comps.length, 1, `one connected hull for ${JSON.stringify(p)}: ${JSON.stringify(comps)}`);
  }
});

test('crystal: the requested length is exact and the internal center is reported', () => {
  /* a 127-length shard must paste as 127 blocks — the tips are part of the
     connected hull, so the assembler keeps every block */
  const r = Gen.genCrystal({ heightY: 127 });
  assert.strictEqual(r.maxX - r.minX + 1, 127, '127 long exactly');
  /* the center marker target: the middle of the long axis at the widest
     cross-section, in emitted coordinates */
  assert.ok(r.center && r.center.x === 63 && r.center.y >= 0 && r.center.z >= 0, JSON.stringify(r.center));
  const u = Gen.genCrystal({ orientation: 'vertical', heightY: 127, leanX: 0 });
  assert.ok(u.center && u.center.y === 63, JSON.stringify(u.center));
});

/* ---------- shapes ---------- */
test('shapes: every primitive generates, with sane hollow interiors', () => {
  for (const kind of ['sphere', 'cylinder', 'cone', 'pyramid', 'torus', 'dome']) {
    const s = Gen.genShapes({ kind, sizeX: 20, sizeY: 20, sizeZ: 20 });
    assert.ok(s.count > 0, `${kind} nonempty`);
    assert.ok(s.interior > 0, `${kind} hollow cavity`);
    assert.ok(s.interior < s.solid, `${kind} interior < solid`);
    assert.strictEqual(s.kind, kind);
  }
});

test('shapes: solid mode, shell thickness, materials', () => {
  const hollow = Gen.genShapes({ kind: 'sphere', sizeX: 20, sizeY: 20, sizeZ: 20 });
  const solid = Gen.genShapes({ kind: 'sphere', sizeX: 20, sizeY: 20, sizeZ: 20, hollow: false });
  assert.strictEqual(solid.interior, 0);
  assert.strictEqual(solid.count, solid.solid);
  const thick = Gen.genShapes({ kind: 'sphere', sizeX: 20, sizeY: 20, sizeZ: 20, shell: 3 });
  assert.ok(thick.count > hollow.count);
  const glass = Gen.genShapes({ kind: 'sphere', sizeX: 10, sizeY: 10, sizeZ: 10, material: 'glass' });
  for (let i = 0; i < glass.count; i++) assert.strictEqual(glass.types[i], 20 /* CRYSTAL */);
  const log = Gen.genShapes({ kind: 'sphere', sizeX: 10, sizeY: 10, sizeZ: 10, material: 'log' });
  assert.strictEqual(log.logs, log.count);
  const plank = Gen.genShapes({ kind: 'sphere', sizeX: 10, sizeY: 10, sizeZ: 10, material: 'planks' });
  assert.strictEqual(plank.planks, plank.count);
});

test('shapes: torus ring fits its box; big grids are capped', () => {
  const t = Gen.genShapes({ kind: 'torus', sizeX: 30, sizeY: 10, sizeZ: 30 });
  assert.ok(t.maxX - t.minX + 1 <= 62);
  const big = Gen.genShapes({ kind: 'sphere', sizeX: 200, sizeY: 200, sizeZ: 200 });
  assert.ok(big.count > 0);
  assert.ok(big.count + big.interior <= 24000000 + 1);
});

/* ---------- dispatch ---------- */
test('dispatch: known kinds route, removed kinds fall back to balloon', () => {
  assert.strictEqual(Gen.gen('crystal', {}).facets, 4);
  assert.strictEqual(Gen.gen('shapes', {}).kind, 'sphere');
  assert.ok(Gen.gen('machines', {}).count > 0);      /* falls back */
  assert.ok(Gen.gen('ships', {}).count > 0);         /* falls back */
  assert.ok(Gen.gen('math', {}).count > 0);          /* falls back */
  assert.strictEqual(typeof Gen.genSteamEngine, 'undefined');
  assert.strictEqual(typeof Gen.genAirship, 'undefined');
  assert.strictEqual(typeof Gen.genMath, 'undefined');
});

/* ---------- schematic lab ---------- */
function buildTinySchem() {
  const b = [];
  const u8 = (v) => b.push(v & 0xff);
  const i16 = (v) => { b.push((v >> 8) & 0xff, v & 0xff); };
  const i32 = (v) => { b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); };
  const str = (s) => { const e = new TextEncoder().encode(s); i16(e.length); for (const c of e) u8(c); };
  const tagName = (tag, name) => { u8(tag); str(name); };
  const compound = (fn) => { fn(); u8(0); };   /* modern 1.21 list member: fields + END, no wrapper */
  const int = (name, v) => { tagName(3, name); i32(v); };
  const strF = (name, v) => { tagName(8, name); str(v); };
  const intList = (name, vals) => { tagName(9, name); u8(3); i32(vals.length); for (const v of vals) i32(v); };
  /* root */
  u8(10); i16(0);
  int('DataVersion', 3955);
  intList('size', [3, 1, 2]);
  /* palette: [burner, air] */
  tagName(9, 'palette'); u8(10); i32(2);
  compound(() => { strF('Name', 'aeronautics:adjustable_burner'); tagName(10, 'Properties'); strF('powered', 'false'); u8(0); });
  compound(() => { strF('Name', 'minecraft:air'); });
  /* blocks: [{pos,state} x2] */
  tagName(9, 'blocks'); u8(10); i32(2);
  compound(() => { intList('pos', [0, 0, 0]); int('state', 0); });
  compound(() => { intList('pos', [1, 0, 0]); int('state', 1); });
  u8(0); /* close root */
  return Uint8Array.from(b);
}

test('schematic lab: parses a sponge v2 schematic (counts, namespaces, aero census)', async () => {
  const bytes = buildTinySchem();
  const r = await Gen.analyzeSchematic(bytes);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total, 2);
  assert.deepStrictEqual(r.size, { x: 2, y: 1, z: 1 });   /* occupied bbox, not the nominal size field */
  assert.strictEqual(r.dataVersion, 3955);
  assert.strictEqual(r.palette[0].name, 'aeronautics:adjustable_burner');
  assert.strictEqual(r.palette[0].count, 1);
  assert.strictEqual(r.namespaces.aeronautics, 1);
  assert.strictEqual(r.namespaces.minecraft, 1);
  assert.strictEqual(r.aero.burner, 1);
  assert.strictEqual(r.mass, 2 * 1 + 0);
});

test('schematic lab: gzip round-trip and mass params', async () => {
  const bytes = buildTinySchem();
  const gz = new Uint8Array(zlib.gzipSync(bytes));
  const r = await Gen.analyzeSchematic(gz, { blockMass: 2.5, payload: 100 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.gzipped, true);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.mass, 2 * 2.5 + 100);
});

test('schematic lab: rejects garbage', async () => {
  const junk = new Uint8Array([1, 2, 3, 4, 5]);
  const r = await Gen.analyzeSchematic(junk);
  assert.strictEqual(r.ok, false);
  const badGz = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
  const r2 = await Gen.analyzeSchematic(badGz);
  assert.strictEqual(r2.ok, false);
});


test('schematic lab: an unsupported NBT tag fails loudly instead of parsing garbage', async () => {
  /* root compound holding one field with tag 13 (does not exist): the payload
     length is unknown, so continuing would desync every following offset */
  const b = [10, 0, 0, 13, 0, 1, 0x78, 1, 2, 3, 4, 0];
  const r = await Gen.analyzeSchematic(Uint8Array.from(b));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /unsupported NBT tag 13/, 'error names the offending tag: ' + r.error);
});

test('schematic lab: parse errors carry the underlying reason', async () => {
  /* a truncated compound: the DataView read runs off the end */
  const b = [10, 0, 0, 3, 0, 1, 0x61, 0, 0];
  const r = await Gen.analyzeSchematic(Uint8Array.from(b));
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /^corrupt NBT data: .+/, 'reason kept: ' + r.error);
  const badGz = new Uint8Array([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3, 1, 2, 3]);
  const r2 = await Gen.analyzeSchematic(badGz);
  assert.strictEqual(r2.ok, false);
  assert.match(r2.error, /^gzip inflate failed: .+/, 'inflate reason kept: ' + r2.error);
  assert.strictEqual(Gen.errText(new Error('boom')), 'boom');
  assert.strictEqual(Gen.errText(null), 'unknown error');
});

/* ---------- worker error propagation ---------- */
/* boot engine-worker.js the way a real worker does: importScripts pulls the
   engine into the same global, and self carries onmessage/postMessage */
function bootWorker() {
  const ctx = vm.createContext({ console, performance: { now: () => 0 } });
  const posted = [];
  ctx.__post = (m) => posted.push(m);
  vm.runInContext('self = globalThis; self.postMessage = __post;', ctx);
  const root = path.join(__dirname, '..');
  ctx.importScripts = () => new vm.Script(fs.readFileSync(path.join(root, 'engine.js'), 'utf8')).runInContext(ctx);
  new vm.Script(fs.readFileSync(path.join(root, 'engine-worker.js'), 'utf8')).runInContext(ctx);
  return { ctx, posted };
}

test('worker: a generation failure is posted back, not left as an opaque onerror', () => {
  const { ctx, posted } = bootWorker();
  vm.runInContext('Gen.gen = function () { throw new Error("bad slider"); };', ctx);
  ctx.self.onmessage({ data: { id: 7, kind: 'crystal', params: {} } });
  assert.strictEqual(posted.length, 1);
  /* the object comes from the worker realm, so compare fields, not identity */
  assert.strictEqual(posted[0].id, 7);
  assert.strictEqual(posted[0].kind, 'crystal');
  assert.strictEqual(posted[0].error, 'bad slider');
});

test('worker: successful generation still posts the model', () => {
  const { ctx, posted } = bootWorker();
  ctx.self.onmessage({ data: { id: 3, kind: 'shapes', params: {} } });
  assert.strictEqual(posted.length, 1);
  assert.strictEqual(posted[0].id, 3);
  assert.strictEqual(posted[0].error, undefined);
  assert.ok(posted[0].count > 0);
});

test('schematic lab: legacy pre-1.20.2 list wrappers also parse', async () => {
  const b = [];
  const u8 = (v) => b.push(v & 0xff);
  const i16 = (v) => { b.push((v >> 8) & 0xff, v & 0xff); };
  const i32 = (v) => { b.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff); };
  const str = (s) => { const e = new TextEncoder().encode(s); i16(e.length); for (const c of e) u8(c); };
  const tagName = (tag, name) => { u8(tag); str(name); };
  const int = (name, v) => { tagName(3, name); i32(v); };
  const strF = (name, v) => { tagName(8, name); str(v); };
  const intList = (name, vals) => { tagName(9, name); u8(3); i32(vals.length); for (const v of vals) i32(v); };
  u8(10); i16(0);
  int('DataVersion', 2860);                       /* old DataVersion */
  intList('size', [1, 1, 1]);
  tagName(9, 'palette'); u8(10); i32(1);
  u8(10); i16(0);                                /* legacy wrapper: 0a 00 00 */
  strF('Name', 'minecraft:stone'); u8(0);
  tagName(9, 'blocks'); u8(10); i32(1);
  u8(10); i16(0);
  intList('pos', [0, 0, 0]); int('state', 0); u8(0);
  u8(0);
  const r = await Gen.analyzeSchematic(Uint8Array.from(b));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.palette[0].name, 'minecraft:stone');
  assert.strictEqual(r.dataVersion, 2860);
});

/* ---------- balance checker ---------- */
test('balance: mass table covers the known Create heavyweights', () => {
  assert.strictEqual(Gen.massOf('create:andesite_casing'), 4);
  assert.strictEqual(Gen.massOf('create:brass_casing'), 5);
  assert.strictEqual(Gen.massOf('create:steam_engine'), 8);
  assert.strictEqual(Gen.massOf('aeronautics:adjustable_burner'), 2);
  assert.strictEqual(Gen.massOf('minecraft:stone'), 1);
  assert.strictEqual(Gen.massOf('aeronautics:white_envelope'), 1);
});

test('balance: comFor is the weighted average', () => {
  const com = Gen.comFor([
    { x: 0.5, y: 0.5, z: 0.5, m: 2 },
    { x: 1.5, y: 0.5, z: 0.5, m: 1 },
  ]);
  assert.ok(Math.abs(com.x - (0.5 * 2 + 1.5 * 1) / 3) < 1e-9);
  assert.ok(Math.abs(com.y - 0.5) < 1e-9);
  assert.strictEqual(com.mass, 3);
  const empty = Gen.comFor([]);
  assert.strictEqual(empty.mass, 0);
});

test('balance: schematic audit reports COM, middle and offset', async () => {
  const bytes = buildTinySchem();   /* burner(0,0,0) m2 + air(1,0,0) m1 */
  const r = await Gen.analyzeSchematic(bytes);
  assert.strictEqual(r.ok, true);
  assert.ok(r.blocks && r.blocks.length === 2);
  assert.ok(Math.abs(r.com.x - (0.5 * 2 + 1.5) / 3) < 1e-9, 'COM weighted by the mass table');
  assert.strictEqual(r.center.x, 1, 'middle of the occupied bbox');
  assert.ok(Math.abs(r.comOffset.x - (r.com.x - 1)) < 1e-9);
  assert.strictEqual(r.comBalanced, true, 'within a block');
});

test('balance: comCheck rates the ship\'s internal balance and the centered craft', () => {
  const crystal = Gen.genCrystal({ jitter: 0, crackCount: 0, inclusionCount: 0, leanX: 0, leanZ: 0 });
  /* a symmetric 3×3×3 stone cube: internally balanced */
  const audit = { palette: [{ name: 'minecraft:stone' }, { name: 'create:brass_casing' }], blocks: [] };
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dz = -1; dz <= 1; dz++)
        audit.blocks.push({ x: 10 + dx, y: 10 + dy, z: 10 + dz, state: 0 });
  const ck = Gen.comCheck(crystal, audit);
  assert.ok(Math.abs(ck.offset.x) <= 0.5 && Math.abs(ck.offset.y) <= 0.5 && Math.abs(ck.offset.z) <= 0.5, 'symmetric ship is internally balanced');
  assert.strictEqual(ck.balanced, true);
  assert.strictEqual(ck.shipMass, 27);
  /* a lopsided ship: one stone + a heavy brass block far away — the verdict
     must point at the brass side */
  const lop = { palette: [{ name: 'minecraft:stone' }, { name: 'create:brass_casing' }],
    blocks: [{ x: 0, y: 0, z: 0, state: 0 }, { x: 10, y: 0, z: 0, state: 1 }] };
  const ck2 = Gen.comCheck(crystal, lop);
  assert.ok(ck2.offset.x > 2, `brass pulls the COM +X: ${ck2.offset.x}`);
  assert.strictEqual(ck2.balanced, false);
  assert.strictEqual(ck2.shipMass, 6);
  /* the centered craft's imbalance comes only from the crystal's own shape */
  assert.ok(Math.abs(ck2.combinedOffset.x) <= 1.1 && Math.abs(ck2.combinedOffset.z) <= 1.1);
});

test('balance: six-axis report — offsets, tilt/pan/yaw, verdicts, fixes', () => {
  /* a deliberately lopsided ship: heavy brass right-front, light planks left-back */
  const entries = [
    { x: 6.5, y: 5.5, z: 6.5, m: 5 },   /* brass, right-front */
    { x: 4.5, y: 5.5, z: 4.5, m: 1 },   /* plank */
    { x: 4.5, y: 5.5, z: 4.5, m: 1 },
    { x: 4.5, y: 5.5, z: 4.5, m: 1 }
  ];
  const rep = Gen.balanceReport(entries, { x: 5, y: 5.5, z: 5 });
  assert.ok(rep.offset.x > 0, 'back/forth leans toward the front');
  assert.ok(rep.offset.z > 0, 'left/right leans right');
  assert.strictEqual(rep.axes.backForth.status, 'wonky', 'small offsets are wonky, not bad');
  assert.strictEqual(rep.verdict, 'wonky');
  assert.ok(rep.fixes.some((fx) => fx.includes('toward the tail')), 'fix points the other way: ' + rep.fixes.join(' | '));
  assert.ok(rep.fixes.some((fx) => fx.includes('toward the left')), 'fix points the other way: ' + rep.fixes.join(' | '));
  /* symmetric ship = perfectly straight */
  const even = Gen.balanceReport([
    { x: 4.5, y: 5.5, z: 4.5, m: 2 }, { x: 5.5, y: 5.5, z: 4.5, m: 2 },
    { x: 4.5, y: 5.5, z: 5.5, m: 2 }, { x: 5.5, y: 5.5, z: 5.5, m: 2 }
  ], { x: 5, y: 5.5, z: 5 });
  assert.strictEqual(even.verdict, 'ok', 'symmetric ship reads perfectly straight');
  assert.strictEqual(even.fixes.length, 0);
  /* yaw twist: front half right, back half left */
  const twist = Gen.balanceReport([
    { x: 6.5, y: 5.5, z: 6.5, m: 2 }, { x: 6.5, y: 5.5, z: 7.5, m: 2 },
    { x: 3.5, y: 5.5, z: 3.5, m: 2 }, { x: 3.5, y: 5.5, z: 2.5, m: 2 }
  ], { x: 5, y: 5.5, z: 5 });
  assert.ok(Math.abs(twist.yawTwist) > 1, 'front-right + back-left reads as yaw twist: ' + twist.yawTwist);
});

test('balance: ship placement offsets trim the combined craft COM', () => {
  const crystal = Gen.genCrystal({ jitter: 0, crackCount: 0, inclusionPct: 0, leanX: 0, leanZ: 0 });
  const audit = {
    palette: [{ name: 'minecraft:oak_planks' }, { name: 'create:brass_casing' }],
    blocks: [{ x: 5, y: 5, z: 5, state: 1 }, { x: 7, y: 5, z: 5, state: 0 }]
  };
  const ck0 = Gen.comCheck(crystal, audit, 0, 0);
  const ck = Gen.comCheck(crystal, audit, ck0.autoTrim.x, ck0.autoTrim.z);
  assert.ok(Math.abs(ck.combinedOffset.x) <= 1.1 && Math.abs(ck.combinedOffset.z) <= 1.1,
    'auto-trim placement lands the combined COM on the middle');
  assert.ok(ck.ship && ck.combined && ck.ship.axes && ck.combined.axes, 'full reports attached');
});

test('balance: overlay merges ship into the crystal, COM-aligned', () => {
  const crystal = Gen.genCrystal({ jitter: 0, crackCount: 0, inclusionCount: 0 });
  const audit = {
    palette: [{ name: 'minecraft:oak_planks' }, { name: 'create:brass_casing' }],
    blocks: [{ x: 5, y: 5, z: 5, state: 1 }, { x: 7, y: 5, z: 5, state: 0 }],
  };
  const merged = Gen.overlay(crystal, audit);
  assert.strictEqual(merged.count, crystal.count + 2);
  assert.ok(merged.types.some((t) => t >= 100), 'uploaded blocks carry palette types');
  assert.ok(merged.overlayCheck && merged.overlayCheck.shipMass === 6, 'brass 5 + plank 1');
  /* the ship COM lands on the crystal middle after the shift */
  const ck = merged.overlayCheck;
  const shipBlocks = merged.positions.slice(crystal.count * 3);
  let sx = 0, sm = 0;
  for (let i = 0; i < audit.blocks.length; i++) {
    const m = audit.blocks[i].state === 1 ? 5 : 1;
    sx += (shipBlocks[i * 3] + 0.5) * m; sm += m;
  }
  /* whole-block shifting lands the COM within half a block of the middle */
  assert.ok(Math.abs(sx / sm - ck.crystalCenter.x) <= 0.5, 'shifted ship COM within half a block of the middle');
});

/* ---------- performance smoke ---------- */
test('perf: large balloon and crystal generate quickly', () => {
  const t0 = Date.now();
  Gen.genBalloon(perfect({ lengthX: 200, widthZ: 100, heightY: 100, profileScale: 1 }));
  const t1 = Date.now();
  Gen.genCrystal({ heightY: 150, baseDiagX: 80, baseDiagZ: 60, ship: true, seed: 7 });
  const t2 = Date.now();
  assert.ok(t1 - t0 < 3000, `balloon ${t1 - t0}ms`);
  assert.ok(t2 - t1 < 3000, `crystal ${t2 - t1}ms`);
});
