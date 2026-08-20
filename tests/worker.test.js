/* worker.test.js — boots engine-worker.js with a worker-global stub. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const workerSrc = fs.readFileSync(path.join(ROOT, 'engine-worker.js'), 'utf8');
const engineScript = new vm.Script(fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8'), { filename: 'engine.js' });
const workerScript = new vm.Script(workerSrc, { filename: 'engine-worker.js' });

function boot() {
  const posted = [];
  const ctx = {
    console, performance: { now: (() => { let n = 100; return () => n++; })() },
    importScripts() { engineScript.runInContext(ctx); },
    postMessage(result, transfer) { posted.push({ result, transfer }); },
  };
  ctx.self = ctx;
  vm.createContext(ctx);
  workerScript.runInContext(ctx);
  return { ctx, posted };
}

test('worker: normal and unknown kinds return ids, timings and transferred buffers', () => {
  const { ctx, posted } = boot();
  ctx.onmessage({ data: { kind: 'crystal', params: { heightY: 12, baseDiagX: 8, baseDiagZ: 6, jitter: 0, crackCount: 0, inclusionCount: 0 }, id: 7 } });
  const normal = posted[0];
  assert.strictEqual(normal.result.id, 7);
  assert.strictEqual(normal.result.kind, 'crystal');
  assert.strictEqual(typeof normal.result.timeMs, 'number');
  assert.strictEqual(normal.transfer.length, 2);
  assert.strictEqual(normal.transfer[0], normal.result.positions.buffer);
  assert.strictEqual(normal.transfer[1], normal.result.types.buffer);
  ctx.onmessage({ data: { kind: 'not-a-kind', params: { lengthX: 8, widthZ: 8, heightY: 8 }, id: 8 } });
  assert.strictEqual(posted[1].result.kind, 'not-a-kind');
  assert.ok(posted[1].result.positions.length > 0);
});

test('worker: solid routes to crystal or balloon and transfers solid positions', () => {
  const { ctx, posted } = boot();
  const originalCrystal = ctx.Gen.genCrystal;
  const originalBalloon = ctx.Gen.genBalloon;
  let crystalParams, balloonParams;
  ctx.Gen.genCrystal = (params) => { crystalParams = params; return originalCrystal(params); };
  ctx.Gen.genBalloon = (params) => { balloonParams = params; return originalBalloon(params); };
  ctx.onmessage({ data: { kind: 'solid', solidOf: 'crystal', params: { heightY: 12, baseDiagX: 8, baseDiagZ: 6, jitter: 0, crackCount: 0, inclusionCount: 0 }, id: 1 } });
  ctx.onmessage({ data: { kind: 'solid', solidOf: 'balloon', params: { lengthX: 8, widthZ: 8, heightY: 8 }, id: 2 } });
  assert.strictEqual(crystalParams.includeSolid, true);
  assert.strictEqual(balloonParams.includeSolid, true);
  for (const { result, transfer } of posted) {
    assert.strictEqual(result.solidPositions.constructor.name, 'Int16Array');
    assert.strictEqual(transfer.length, 3);
    assert.strictEqual(transfer[0], result.positions.buffer);
    assert.strictEqual(transfer[1], result.types.buffer);
    assert.strictEqual(transfer[2], result.solidPositions.buffer);
  }
});
