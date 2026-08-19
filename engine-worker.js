/* engine-worker.js — runs generation off the main thread */
'use strict';
importScripts('engine.js');

self.onmessage = function (e) {
  var msg = e.data;
  var t0 = performance.now();
  var r;
  if (msg.kind === 'solid') {
    r = msg.solidOf === 'crystal'
      ? Gen.genCrystal(Object.assign({}, msg.params, { includeSolid: true }))
      : Gen.genBalloon(Object.assign({}, msg.params, { includeSolid: true }));
  } else {
    r = Gen.gen(msg.kind, msg.params);
  }
  r.id = msg.id;
  r.kind = msg.kind;
  r.timeMs = performance.now() - t0;
  var tr = [r.positions.buffer, r.types.buffer];
  if (r.solidPositions) tr.push(r.solidPositions.buffer);
  self.postMessage(r, tr);
};
