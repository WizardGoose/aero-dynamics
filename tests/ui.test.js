/* ui.test.js — boots the real index.html script in a stubbed DOM (node:test).
   No browser needed: engine runs main-thread, THREE is stubbed so the
   renderer path bails (flat-color fallback), and the worker path is
   exercised by forcing the Worker constructor to throw. */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const uiSrc = html.match(/<script>\n('use strict';\n[\s\S]*?)<\/script>/)[1];
const engineSrc = fs.readFileSync(path.join(ROOT, 'engine.js'), 'utf8');
/* precompile once — recompiling both scripts per boot was the slow part */
const engineScript = new vm.Script(engineSrc, { filename: 'engine.js' });
const uiScript = new vm.Script(uiSrc, { filename: 'index.html#inline' });

/* ---------- stubs ---------- */
function makeEl(id) {
  const listeners = {};
  const el = {
    id, textContent: '', value: '', checked: false, disabled: false,
    style: {}, className: '', files: null, width: 0, height: 0, children: [],
    tagName: '', attrs: {},
    getAttribute(k) { return this.attrs[k] != null ? this.attrs[k] : null; },
    get innerHTML() { return this._innerHTML || ''; },
    set innerHTML(v) {
      this._innerHTML = v;
      /* the panel builder emits seg/swatch buttons inside innerHTML strings —
         parse them into stub children so wiring and clicks work */
      if (el.id === 'panel') {
        if (els['presets']) els['presets'].children = [];   /* fresh panel per build */
        let m;
        const segRe = /<div class="seg" id="sg-([^"]+)">([\s\S]*?)<\/div>/g;
        while ((m = segRe.exec(v))) {
          const cont = (els['sg-' + m[1]] = els['sg-' + m[1]] || makeEl('sg-' + m[1]));
          cont.children = [];
          for (const bm of m[2].matchAll(/<button data-v="([^"]+)"/g)) {
            const b = makeEl('seg-btn'); b.attrs = { 'data-v': bm[1] };
            cont.children.push(b);
          }
        }
        const swRe = /<div class="swatches" id="sw-([^"]+)">([\s\S]*?)<\/div>/g;
        while ((m = swRe.exec(v))) {
          const cont = (els['sw-' + m[1]] = els['sw-' + m[1]] || makeEl('sw-' + m[1]));
          cont.children = [];
          for (const bm of m[2].matchAll(/<button data-v="([^"]+)"/g)) {
            const b = makeEl('sw-btn'); b.attrs = { 'data-v': bm[1] };
            cont.children.push(b);
          }
        }
      }
    },
    classList: {
      _s: new Set(),
      add: (...c) => c.forEach((x) => el.classList._s.add(x)),
      remove: (...c) => c.forEach((x) => el.classList._s.delete(x)),
      toggle: (c, on) => {
        if (on === undefined ? !el.classList._s.has(c) : on) el.classList._s.add(c);
        else el.classList._s.delete(c);
      },
      contains: (c) => el.classList._s.has(c),
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type) { (listeners[type] || []).forEach((f) => f()); },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); },
    setPointerCapture() {},
    click() {
      (listeners.click || []).forEach((f) => f({ preventDefault() {} }));
      if (el.onclick) el.onclick({ preventDefault() {} });
    },
    getContext() {
      return { fillStyle: '', strokeStyle: '', fillRect() {}, strokeRect() {}, fillText() {}, beginPath() {},
        moveTo() {}, lineTo() {}, closePath() {}, fill() {}, stroke() {}, save() {}, restore() {}, translate() {}, scale() {},
        clearRect() {}, setTransform() {}, globalAlpha: 1, font: '', imageSmoothingEnabled: true, drawImage() {} };
    },
  };
  return el;
}
const els = {};
let vmCtx = null;
const documentStub = {
  getElementById: (id) => (els[id] = els[id] || makeEl(id)),
  querySelectorAll: () => [],
  createElement: (tag) => {
    const e = makeEl('<' + tag + '>');
    e.tagName = tag;
    if (tag === 'script') {
      let src = '';
      Object.defineProperty(e, 'src', {
        get: () => src,
        set: (v) => {
          src = v;
          /* capture the executing context NOW (set() runs synchronously inside
             the vm script) — a shared late-binding variable would let a stale
             context's pending load run in the wrong context */
          const target = vmCtx;
          setTimeout(() => {
            /* real <script src=engine.js> executes the engine in the page:
               run it in the vm context before firing onload */
            if (v.endsWith('engine.js')) engineScript.runInContext(target);
            e.onload && e.onload();
          }, 0);
        },
      });
    }
    return e;
  },
  head: { appendChild() {} },
  body: { appendChild() {}, removeChild() {} },
  addEventListener() {},
};

function threeStub() {
  const V3 = function (x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; };
  V3.prototype.set = function (x, y, z) { this.x = x; this.y = y; this.z = z; return this; };
  const Cam = function () { this.position = new V3(); this.aspect = 1; this.rotation = new V3(); };
  Cam.prototype.lookAt = function () {}; Cam.prototype.updateProjectionMatrix = function () {};
  const MeshMat = function (opts) {
    this.color = { set() {} }; this.map = null; this.roughness = 0; this.metalness = 0;
    this.transparent = false; this.opacity = 1; this.emissive = null; this.emissiveIntensity = 0;
    this.needsUpdate = false; this.dispose = function () {};
  };
  const Inst = function (geo, mat, n) {
    this.geometry = geo; this.material = mat;
    this.instanceMatrix = { setUsage() {}, needsUpdate: false };
    this.instanceColor = null;
    this.setMatrixAt = function () {}; this.setColorAt = function () { this.instanceColor = { needsUpdate: false }; };
    this.computeBoundingSphere = function () {};
    this.dispose = function () {};
  };
  return {
    Scene: function () { this.background = null; this.fog = null; this.environment = null; this.add = function () {}; },
    Color: function (c) { this.c = c; },
    FogExp2: function (c, d) { this.color = c; this.density = d; },
    PerspectiveCamera: Cam,
    WebGLRenderer: function () { throw new Error('no WebGL in tests'); },
    AmbientLight: function () { this.position = { set() {} }; },
    DirectionalLight: function () {
      this.position = { set() {} };
      this.castShadow = false;
      this.shadow = {
        mapSize: { set() {} },
        camera: { left: 0, right: 0, top: 0, bottom: 0, near: 0, far: 0, updateProjectionMatrix() {} },
        bias: 0, normalBias: 0
      };
    },
    HemisphereLight: function () { this.position = { set() {} }; },
    PlaneGeometry: function () {},
    ShadowMaterial: function (o) { this.opacity = (o && o.opacity) || 1; },
    Mesh: function () { this.rotation = { x: 0 }; this.position = { y: 0 }; },
    PMREMGenerator: function () { this.fromScene = function () { return { texture: null }; }; },
    TextureLoader: function () {
      this.load = function (src, ok, _undef, err) { if (err) err(null); };
    },
    GridHelper: function () { this.position = { y: 0 }; },
    Group: function () { this.children = []; this.add = function () {}; this.remove = function () {}; },
    BoxGeometry: function () {}, InstancedMesh: Inst, MeshStandardMaterial: MeshMat,
    Object3D: function () { this.position = { set() {} }; this.matrix = {}; this.updateMatrix = function () {}; },
    Vector3: V3, CanvasTexture: function () {},
    NearestFilter: 1, NearestMipmapLinearFilter: 2, SRGBColorSpace: 'srgb',
    ACESFilmicToneMapping: 1, DynamicDrawUsage: 1,
  };
}

function boot() {
  const ctx = {
    console, clearTimeout, btoa, atob, TextEncoder, URL, Blob, Response,
    setTimeout: fastSetTimeout,
    CompressionStream, DecompressionStream, Date, Math, JSON, Object, Array, Promise,
  };
  ctx.performance = { now: () => Date.now() };
  ctx.requestAnimationFrame = () => {};
  ctx.location = { href: 'http://localhost/index.html', hash: '' };
  ctx.window = { addEventListener() {} };
  ctx.navigator = {};
  vmCtx = ctx;
  ctx.document = documentStub;
  ctx.THREE = threeStub();
  /* simulate the REAL browser flow: the Worker constructor succeeds, generation
     runs through the worker's dispatch (Gen on the main thread — exactly the
     setup that broke with "Gen is not defined" when the panels called Gen). */
  ctx.Worker = function () {
    this.onmessage = null;
    this.onerror = null;
    this.postMessage = function (msg) {
      setTimeout(() => {
        try {
          let r;
          if (msg.kind === 'solid') {
            r = msg.solidOf === 'crystal'
              ? ctx.Gen.genCrystal(Object.assign({}, msg.params, { includeSolid: true }))
              : ctx.Gen.genBalloon(Object.assign({}, msg.params, { includeSolid: true }));
          } else {
            r = ctx.Gen.gen(msg.kind, msg.params);
          }
          r.id = msg.id; r.kind = msg.kind; r.timeMs = 0.4;
          this.onmessage && this.onmessage({ data: r });
        } catch (err) {
          this.onerror && this.onerror(err);
        }
      }, 1);
    };
    this.terminate = function () {};
  };
  ctx.self = undefined;
  vm.createContext(ctx);
  /* engine.js is NOT preloaded: it must arrive via the <script> tag, like the browser */
  uiScript.runInContext(ctx);
  return ctx;
}

/* the UI's safety-net (3000ms) and resize (150ms) timers otherwise keep the
   event loop alive for seconds after each boot — compress long vm timers. */
const fastSetTimeout = (fn, ms, ...a) => setTimeout(fn, ms > 20 ? Math.min(ms, 10) : ms, ...a);
const tick = () => new Promise((r) => setTimeout(r, 10));

test('ui: boots with the balloon tab generating', async () => {
  const ctx = boot();
  await tick();
  assert.strictEqual(ctx.state.tab, 'balloon');
  assert.ok(Number(els['st-blocks'].textContent.replace(/\D/g, '')) > 100, 'balloon stats populated: ' + els['st-blocks'].textContent);
  assert.ok(els['st-badge'].innerHTML.includes('badge'), 'badge set');
  assert.ok(els['req-body'].innerHTML.includes('Burners'), 'requirements panel renders for balloon');
});

test('ui: every generator tab switches, generates, stats + requirements render', async () => {
  const ctx = boot();
  for (const tab of ['balloon', 'prop', 'wings', 'crystal', 'shapes']) {
    ctx.switchTab(tab);
    await tick();
    assert.strictEqual(ctx.state.tab, tab);
    assert.ok(ctx.state.result && ctx.state.result.count > 0, tab + ' generated a model');
    assert.ok(els['st-blocks'].textContent !== '—', tab + ' stats populated');
    assert.ok(els['req-body'].innerHTML.length > 10, tab + ' requirements rendered');
    assert.ok(!els['req'].classList._s.has('hidden'), tab + ' requirements panel visible');
  }
  /* lab: no generation, upload UI present */
  ctx.switchTab('lab');
  await tick();
  assert.ok(els['panel'].innerHTML.includes('labdrop'), 'lab drop zone built');
  assert.ok(els['req'].classList._s.has('hidden'), 'req panel hidden in lab');
});

test('ui: share links round-trip for every tab (params survive encode/decode)', async () => {
  const ctx = boot();
  const cases = {
    balloon: { lengthX: 45, widthZ: 23, perfect: false, envelopeColor: 'lime', blockMass: 1.5, payload: 240 },
    prop: { blades: 6, length: 18, tipChord: 4, airfoilShape: 'linear', bladeMaterial: 'sail', rotation: 45 },
    wings: { halfSpan: 20, rootChord: 8, tipChord: 3, sweepBlocks: 5, planform: 'delta', wingBlock: 'copycat_wing_12', mirror: false },
    crystal: { heightY: 52, baseDiagX: 26, baseDiagZ: 18, facets: 6, taperPower: 1.2, topCrop: 0.2, midY: 0.3, midBand: 0.25, twistDeg: 60,
      leanX: 3.5, leanZ: 1.5, asym: 0.2, jitter: 0.15, crackCount: 7, inclusionPct: 4, seed: 4242,
      hollow: true, shell: 2, blockMass: 1.5, payload: 100, material: 'levitite', inclusionMaterial: 'amethyst_block', orientation: 'vertical', centerMode: 'even' },
    shapes: { kind: 'torus', sizeX: 40, sizeY: 12, sizeZ: 40, axis: 'y', hollow: true, shell: 1, material: 'glass', envelopeColor: 'red', frameWoodType: 'cherry' },
  };
  for (const tab of Object.keys(cases)) {
    const enc = ctx.encodeParams(tab, cases[tab]);
    assert.ok(enc.startsWith({ balloon: 'b3', prop: 'p3', wings: 'w4', crystal: 'c5', shapes: 'h5' }[tab]), tab + ' prefix: ' + enc);
    const dec = ctx.decodeParams(tab, enc);
    for (const k of Object.keys(cases[tab])) {
      const want = cases[tab][k], got = dec[k];
      if (typeof want === 'number') {
        assert.ok(Math.abs(want - got) < 0.011, `${tab}.${k}: ${want} vs ${got} (${enc})`);
      } else {
        assert.strictEqual(got, want, `${tab}.${k} (${enc})`);
      }
    }
  }
});

test('ui: a shared crystal link routes, regenerates and reproduces the same shard', async () => {
  const ctx = boot();
  await tick();
  const p = { heightY: 40, baseDiagX: 20, baseDiagZ: 14, seed: 777, jitter: 0.2, twistDeg: 90, crackCount: 4, material: 'amethyst_block' };
  const hash = '#' + ctx.b64u(ctx.encodeParams('crystal', p));
  ctx.location.hash = hash;
  ctx.applyHash();
  await tick();
  assert.strictEqual(ctx.state.tab, 'crystal');
  assert.strictEqual(ctx.state.params.seed, 777);
  assert.strictEqual(ctx.state.params.material, 'amethyst_block');
  const r = ctx.state.result;
  assert.ok(r && r.count > 0 && r.facets === 4);
});

test('ui: center-block option adds one sea lantern at the model middle', async () => {
  const ctx = boot();
  await tick();
  ctx.switchTab('crystal');
  await tick();
  const cb = ctx.document.getElementById('cb-center');
  cb.checked = true;
  const r = ctx.state.result, p = ctx.state.params;
  const nbt = ctx.buildSchematic(r, p);
  const audit = await ctx.Gen.analyzeSchematic(nbt);
  assert.strictEqual(audit.ok, true);
  assert.strictEqual(audit.total, r.count + 1, 'center block added (cavity is empty there)');
  const lantern = audit.palette.find((e) => e.name === 'minecraft:sea_lantern');
  /* the crystal's inclusions are sea lanterns too — the marker adds exactly one */
  assert.strictEqual(lantern.count, r.inclusionTotal + 1, 'one extra sea lantern at the center');
  /* the marker sits at the shard's INTERNAL center (r.center), not the bbox middle */
  const cen = r.center;
  const atCenter = audit.blocks.filter((b) => b.x === cen.x - r.minX && b.y === cen.y - r.minY && b.z === cen.z - r.minZ);
  assert.ok(atCenter.length >= 1, 'sea lantern at the internal center ' + JSON.stringify(cen));
  cb.checked = false;
  const nbt2 = ctx.buildSchematic(r, p);
  const audit2 = await ctx.Gen.analyzeSchematic(nbt2);
  assert.strictEqual(audit2.total, r.count, 'toggle off — unchanged');
});

test('ui: crystal schematic export closes the loop through the lab reader', async () => {
  const ctx = boot();
  await tick();
  ctx.switchTab('crystal');
  await tick();
  const r = ctx.state.result, p = ctx.state.params;
  const nbt = ctx.buildSchematic(r, p);
  assert.ok(nbt.length > 100, 'schematic bytes emitted');
  const audit = await ctx.Gen.analyzeSchematic(nbt);
  assert.strictEqual(audit.ok, true, JSON.stringify(audit).slice(0, 200));
  assert.strictEqual(audit.total, r.count);
  const names = audit.palette.map((e) => e.name);
  assert.ok(names.includes('minecraft:glass'), 'glass hull in palette');
  assert.ok(!names.some((n) => n.startsWith('aeronautics:')), 'pure shard — no drive blocks');
  assert.ok(!names.some((n) => n.startsWith('simulated:')), 'pure shard — no control blocks');
  assert.strictEqual(audit.aero.burner, 0);
  assert.strictEqual(audit.aero.assembler, 0);
});

test('ui: lab tab audits a dropped file end-to-end', async () => {
  const ctx = boot();
  await tick();
  /* export a balloon schematic first */
  ctx.switchTab('balloon');
  await tick();
  const nbt = ctx.buildSchematic(ctx.state.result, ctx.state.params);
  /* switch to lab and simulate the file input */
  ctx.switchTab('lab');
  await tick();
  const fileEl = els['lab-file'];
  assert.ok(fileEl, 'file input created');
  fileEl.files = [{ name: 'balloon.schem', arrayBuffer: async () => nbt.buffer.slice(0, nbt.byteLength) }];
  fileEl.onchange();
  await tick(); await tick();
  const out = els['lab-out'].innerHTML;
  assert.ok(out.includes('minecraft:white_wool'), 'palette rendered: ' + out.slice(0, 120));
  assert.ok(out.includes('Aeronautics census: no Create Aeronautics blocks found') ||
    out.includes('burner'), 'census rendered');
  assert.ok(els['st-blocks'].textContent !== '—', 'lab stats populated');
});

test('ui: lab rejects garbage files gracefully', async () => {
  const ctx = boot();
  await tick();
  ctx.switchTab('lab');
  await tick();
  const fileEl = els['lab-file'];
  fileEl.files = [{ name: 'junk.schem', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }];
  fileEl.onchange();
  await tick(); await tick();
  assert.ok(els['lab-out'].innerHTML.includes('✘'), 'error rendered');
});

test('ui: every handbook link in wiki.html decodes and generates', async () => {
  const wiki = fs.readFileSync(path.join(ROOT, 'wiki.html'), 'utf8');
  /* the ponder player builds .golink hrefs from JS string arrays, so scan for
     every index.html#token instead of only double-quoted href attributes */
  const hrefs = [...new Set([...wiki.matchAll(/index\.html#([A-Za-z0-9_.\-]+)/g)].map((m) => m[1]))];
  assert.ok(hrefs.length >= 12, `expected many handbook links, got ${hrefs.length}`);
  const PREFIX_TAB = { b3: 'balloon', p3: 'prop', w4: 'wings', c5: 'crystal', h5: 'shapes' };
  const ctx = boot();
  await tick();
  for (const href of hrefs) {
    let compact;
    try { compact = ctx.unb64u(href); } catch (e) {
      compact = href;   /* legacy compact links (b3./p3. prefixes) */
    }
    const tab = PREFIX_TAB[compact.slice(0, 2)];
    assert.ok(tab, `wiki link routes to a known tab: ${href}`);
    const params = ctx.decodeParams(tab, compact);
    ctx.switchTab(tab);
    Object.assign(ctx.state.params, params);
    ctx.syncControls();
    ctx.updateConditional();
    ctx.requestGen(true);
    await tick();
    assert.ok(ctx.state.result && ctx.state.result.count > 0, `wiki link generates: ${href}`);
  }
});

test('ui: .litematic export round-trips through the lab reader', async () => {
  const ctx = boot();
  await tick();
  ctx.switchTab('crystal');
  await tick();
  const r = ctx.state.result, p = ctx.state.params;
  /* raw NBT bytes, no gzip */
  const bytes = ctx.buildLitematic(r, p, 'test_shard');
  assert.ok(bytes.length > 400, 'litematic bytes produced: ' + bytes.length);
  const audit = await ctx.Gen.analyzeSchematic(bytes);
  assert.ok(audit.ok, 'lab reads the litematic export: ' + (audit.error || ''));
  assert.strictEqual(audit.total, r.count, 'same block count through the round-trip');
  /* air cells (the hollow cavity) are excluded from the census */
  const glass = audit.palette.findIndex((en) => en.name === 'minecraft:glass');
  const air = audit.palette.findIndex((en) => en.name === 'minecraft:air');
  assert.ok(glass >= 0, 'glass palette entry survives');
  assert.strictEqual(air, -1, 'air never reaches the census');
  /* determinism: same bytes on the second build */
  const bytes2 = ctx.buildLitematic(r, p, 'test_shard');
  assert.strictEqual(bytes2.length, bytes.length, 'stable output size');
});

test('ui: lab reports center of mass; the crystal tab balances a dropped ship', async () => {
  const ctx = boot();
  await tick();
  /* export a crystal schematic, then feed it back as the "ship".
     Use a symmetric shard (no cracks / inclusions / nose dip) so the
     PERFECTLY STRAIGHT verdict is deterministic, not seed luck. */
  ctx.switchTab('crystal');
  await tick();
  Object.assign(ctx.state.params, { crackCount: 0, inclusionPct: 0, leanX: 0, leanZ: 0, midY: 0.5, inclusions: [{ material: 'sea_lantern', pct: 0 }] });
  ctx.requestGen(true);
  await tick(); await tick();
  const nbt = ctx.buildSchematic(ctx.state.result, ctx.state.params);
  ctx.switchTab('lab');
  await tick();
  const fileEl = ctx.document.getElementById('lab-file');
  fileEl.files = [{ name: 'ship.schem', arrayBuffer: async () => nbt.buffer.slice(0, nbt.byteLength) }];
  fileEl.onchange();
  await tick(); await tick();
  const out = ctx.document.getElementById('lab-out').innerHTML;
  assert.ok(out.includes('Center of mass'), 'lab COM section rendered');
  assert.ok(out.includes('balanced') || out.includes('off by'), 'lab COM verdict rendered');
  /* jump straight into the crystal balance check */
  ctx.document.getElementById('lab-balance').click();
  await tick(); await tick(); await tick();
  assert.strictEqual(ctx.state.tab, 'crystal');
  assert.ok(ctx.state.crystalAudit, 'audit carried into the crystal tab');
  assert.ok(ctx.state.crystalCheck, 'comCheck computed against the crystal');
  const req = ctx.document.getElementById('req-body').innerHTML;
  assert.ok(req.includes('Ship COM vs its own middle'), 'req panel shows the balance verdict');
  assert.ok(req.includes('Combined craft COM'), 'combined COM shown');
  assert.ok(req.includes('PERFECTLY STRAIGHT'), 'the shard is balanced around its own ship');
  assert.ok(req.includes('✕ clear'), 'clear control present');
  /* clear, then the direct crystal drop zone */
  ctx.clearCom();
  assert.strictEqual(ctx.state.crystalCheck, null);
  assert.ok(!ctx.document.getElementById('req-body').innerHTML.includes('Ship COM'), 'cleared');
  const cfile = ctx.document.getElementById('crystal-file');
  cfile.files = [{ name: 'ship2.schem', arrayBuffer: async () => nbt.buffer.slice(0, nbt.byteLength) }];
  cfile.onchange();
  await tick(); await tick();
  assert.ok(ctx.state.crystalCheck, 'crystal drop zone runs the same check');
});

test('ui: inclusion variants — add rows, set glass materials, share-link round-trip', async () => {
  const ctx = boot();
  await tick();
  ctx.switchTab('crystal');
  await tick();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.state.params.inclusions)), [{ material: 'sea_lantern', pct: 3 }]);
  /* add a second variant and set it to glass */
  ctx.document.getElementById('inc-add').click();
  assert.strictEqual(ctx.state.params.inclusions.length, 2);
  const sel = ctx.document.getElementById('inc-mat-1');
  sel.value = 'tinted_glass';
  sel.fire('change');
  assert.strictEqual(ctx.state.params.inclusions[1].material, 'tinted_glass');
  const pct = ctx.document.getElementById('inc-pct-1');
  pct.value = '7';
  pct.fire('input');
  assert.strictEqual(ctx.state.params.inclusions[1].pct, 7);
  await tick(); await tick();
  /* the generated model reports the variant patches */
  assert.ok(ctx.state.result && Array.isArray(ctx.state.result.inclusions));
  assert.strictEqual(ctx.state.result.inclusions.length, 2);
  assert.strictEqual(ctx.state.result.inclusions[1].material, 'tinted_glass');
  /* remove the extra variant again */
  ctx.document.getElementById('inc-x-1').click();
  assert.strictEqual(ctx.state.params.inclusions.length, 1);
  /* share links carry the whole variant list */
  ctx.state.params.inclusions = [{ material: 'glass', pct: 5 }, { material: 'tinted_glass', pct: 8 }];
  const enc = ctx.encodeParams('crystal', ctx.state.params);
  const dec = ctx.decodeParams('crystal', enc);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(dec.inclusions)), [{ material: 'glass', pct: 5 }, { material: 'tinted_glass', pct: 8 }]);
  assert.strictEqual(dec.inclusionMaterial, 'glass');
});

test('ui: ponder guide opens and steps through balloon and crystal builds', async () => {
  const ctx = boot();
  await tick();
  for (const tab of ['balloon', 'crystal']) {
    ctx.switchTab(tab);
    await tick();
    ctx.document.getElementById('guide-canvas').width = 640;
    ctx.document.getElementById('guide-canvas').height = 480;
    ctx.openGuide();
    assert.ok(ctx.guideSteps.length >= 2, tab + ' guide has steps');
    const gtext = ctx.document.getElementById('guide-text');
    assert.ok(gtext.textContent.length > 0 || gtext.innerHTML.length > 0, tab + ' guide text set');
    /* walk the whole sequence + one cut-section pass */
    for (let i = 0; i < ctx.guideSteps.length + 1; i++) ctx.guideStep(1);
    if (ctx.isBalloonTab()) {
      ctx.document.getElementById('guide-mode-section').click();
      await tick(); await tick();   /* solid pass may be async */
      ctx.guideStep(1);
      ctx.document.getElementById('guide-mode-layers').click();
    }
    ctx.document.getElementById('guide-close').click();
    assert.ok(ctx.document.getElementById('guide-modal').classList._s.has('hidden'), tab + ' guide closed');
  }
});

test('ui: segmented groups, swatches, seed dice and number boxes drive the params', async () => {
  const ctx = boot();
  await tick();
  /* crystal tab */
  ctx.switchTab('crystal');
  await tick();
  assert.strictEqual(ctx.state.params.shell, 1);
  ctx.CTLREG.seg.shell[1].click();
  assert.strictEqual(ctx.state.params.shell, 2, 'segmented shell set');
  const matSel = ctx.document.getElementById('p-material');
  matSel.value = 'amethyst_block';
  matSel.fire('change');
  assert.strictEqual(ctx.state.params.material, 'amethyst_block', 'material dropdown set');
  const incSel = ctx.document.getElementById('p-inclusionMaterial');
  incSel.value = 'glowstone';
  incSel.fire('change');
  assert.strictEqual(ctx.state.params.inclusionMaterial, 'glowstone', 'inclusion dropdown set');
  incSel.value = 'amethyst_block';
  incSel.fire('change');
  ctx.document.getElementById('d-seed').click();
  assert.ok(ctx.state.params.seed >= 0 && ctx.state.params.seed <= 9999, 'dice re-rolled seed');
  const numEl = ctx.document.getElementById('n-heightY');
  numEl.value = '60';
  numEl.fire('input');
  assert.strictEqual(ctx.state.params.heightY, 60, 'number box set height');
  await tick(); await tick();   /* debounce (10ms) + worker round-trip (1ms) */
  assert.strictEqual(ctx.state.result.heightY, 60, 'regenerated with new height');
  /* preset click re-syncs segmented actives (Twin-Spike = levitite) */
  const presetBtn = ctx.document.getElementById('presets').children[2];
  presetBtn.click();
  assert.strictEqual(ctx.state.params.material, 'levitite', 'preset applied its material');
  assert.strictEqual(ctx.document.getElementById('p-material').value, 'levitite', 'material dropdown synced after preset');
  assert.ok(ctx.CTLREG.seg.shell[1].classList._s.has('active'), 'shell active state synced (stays 2)');
  /* balloon tab: swatches + number boxes */
  ctx.switchTab('balloon');
  await tick();
  ctx.CTLREG.swatch.envelopeColor[13].click();
  assert.strictEqual(ctx.state.params.envelopeColor, 'green', 'wool swatch set');
  assert.ok(ctx.CTLREG.swatch.envelopeColor[13].classList._s.has('active'), 'swatch active state set');
  const blen = ctx.document.getElementById('n-lengthX');
  blen.value = '45';
  blen.fire('input');
  assert.strictEqual(ctx.state.params.lengthX, 45, 'balloon number box set');
  /* shapes tab: axis segmented + wood swatch */
  ctx.switchTab('shapes');
  await tick();
  ctx.CTLREG.seg.axis[1].click();
  assert.strictEqual(ctx.state.params.axis, 'x', 'axis segmented set');
  ctx.CTLREG.swatch.frameWoodType[2].click();
  assert.strictEqual(ctx.state.params.frameWoodType, 'birch', 'wood swatch set');
});

test('ui: prop force-one-block-center checkbox drives the param and regenerates', async () => {
  const ctx = boot();
  await tick();
  ctx.switchTab('prop');
  await tick();
  assert.strictEqual(ctx.state.params.forceCenter, true, 'forceCenter defaults on');
  const chk = ctx.document.getElementById('p-forceCenter');
  assert.ok(chk, 'checkbox rendered in the panel');
  chk.checked = false;
  chk.fire('change');
  assert.strictEqual(ctx.state.params.forceCenter, false, 'toggle updates the param');
  await tick(); await tick();   /* debounce + worker round-trip */
  assert.ok(ctx.state.result.count > 0, 'prop regenerated with forceCenter off');
  /* the root row must keep its blocks either way (regression for the old
     row-clearing hub pass) */
  let rowCells = 0;
  const r = ctx.state.result;
  for (let i = 0; i < r.count; i++) {
    const dx = r.positions[i * 3] - r.center[0], dz = r.positions[i * 3 + 2] - r.center[2];
    if (dx === 0 && dz !== 0) rowCells++;
  }
  assert.ok(rowCells > 0, 'root row keeps blocks with forceCenter off: ' + rowCells);
  chk.checked = true;
  chk.fire('change');
  await tick(); await tick();
  let hub = 0;
  const r2 = ctx.state.result;
  for (let i = 0; i < r2.count; i++) {
    if (r2.positions[i * 3] === r2.center[0] && r2.positions[i * 3 + 2] === r2.center[2]) hub++;
  }
  assert.strictEqual(hub, 1, 'exactly one hub with forceCenter on');
});

/* ---------- error propagation ---------- */
test('ui: a worker generation error is reported, not swallowed', async () => {
  const ctx = boot();
  await tick();
  /* the worker reports failures on the message channel (engine-worker.js) */
  ctx.worker.postMessage = function (msg) {
    setTimeout(() => ctx.worker.onmessage({ data: { id: msg.id, kind: msg.kind, error: 'shell too thick' } }), 1);
  };
  els['toast'].textContent = '';
  ctx.state.params.lengthX = 47;
  ctx.requestGen(true);
  await tick(); await tick();
  assert.ok(els['toast'].textContent.includes('shell too thick'), 'toast carries the engine message: ' + els['toast'].textContent);
  assert.strictEqual(ctx.lastGenKey, null, 'dedupe key dropped so the same params can be retried');
});

test('ui: a dead worker falls back to the main thread AND regenerates', async () => {
  const ctx = boot();
  await tick();
  els['toast'].textContent = '';
  ctx.state.result = null;
  ctx.worker.onerror(new Error('worker died'));
  await tick(); await tick();
  assert.strictEqual(ctx.workerMode, true, 'switched to main-thread mode');
  assert.ok(els['toast'].textContent.includes('worker died'), 'failure reported: ' + els['toast'].textContent);
  assert.ok(ctx.state.result && ctx.state.result.count > 0, 'the dropped generation was re-run on the main thread');
});

test('ui: a main-thread generation failure surfaces and stays retryable', async () => {
  const ctx = boot();
  await tick();
  ctx.workerMode = true;
  const realGen = ctx.Gen.gen;
  ctx.Gen.gen = () => { throw new Error('bad params'); };
  els['toast'].textContent = '';
  ctx.state.params.lengthX = 48;
  ctx.requestGen(true);
  await tick();
  assert.ok(els['toast'].textContent.includes('bad params'), 'toast carries the failure: ' + els['toast'].textContent);
  assert.strictEqual(ctx.lastGenKey, null);
  ctx.Gen.gen = realGen;
  ctx.requestGen(true);
  await tick();
  assert.ok(ctx.state.result.count > 0, 'the same params regenerate after the failure');
});

test('ui: a broken share link says so instead of failing silently', async () => {
  const ctx = boot();
  await tick();
  els['toast'].textContent = '';
  ctx.location.hash = '#@@@@@@@@';
  ctx.applyHash();
  assert.ok(els['toast'].textContent.includes('unreadable share link'), 'decode failure reported: ' + els['toast'].textContent);
  els['toast'].textContent = '';
  ctx.location.hash = '#' + ctx.b64u('zz9.1.2');
  ctx.applyHash();
  assert.ok(els['toast'].textContent.includes('not a studio link'), 'unknown prefix reported: ' + els['toast'].textContent);
});

test('ui: a failed export reports the reason', async () => {
  const ctx = boot();
  await tick();
  els['toast'].textContent = '';
  /* a result whose types array is missing: the NBT writer throws */
  ctx.state.result = { count: 3, positions: new Int16Array(9), types: null, minX: 0, minY: 0, minZ: 0, maxX: 1, maxY: 1, maxZ: 1 };
  ctx.doDownload('.nbt');
  assert.ok(els['toast'].textContent.includes('export failed'), 'export failure reported: ' + els['toast'].textContent);
});

test('ui: stat labels switch per tab and machines/ships/math are gone', async () => {
  const ctx = boot();
  assert.ok(!('machines' in ctx.MODULES) && !('ships' in ctx.MODULES) && !('math' in ctx.MODULES), 'cleared modules removed');
  assert.deepStrictEqual(Object.keys(ctx.MODULES).sort(), ['balloon', 'crystal', 'lab', 'prop', 'shapes', 'wings']);
  assert.ok(ctx.MODULES.lab.labels.length === 5);
  for (const tab of ['balloon', 'prop', 'wings', 'crystal', 'shapes', 'lab']) {
    ctx.switchTab(tab);
    await tick();
    const lbls = ctx.MODULES[tab].labels;
    assert.strictEqual(els['lb-blocks'].textContent, lbls[0]);
    assert.strictEqual(els['lb-eff'].textContent, lbls[4]);
  }
});
