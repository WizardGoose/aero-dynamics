/* wiki.test.js — boots the real wiki player in a stubbed DOM (node:test). */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'wiki.html'), 'utf8');
const wikiSrc = html.match(/<script>\n([\s\S]*?)<\/script>/)[1];
const wikiScript = new vm.Script(wikiSrc, { filename: 'wiki.html#inline' });

function makeEl(id) {
  const listeners = {};
  const el = {
    id, textContent: '', disabled: false, children: [], style: {},
    classList: {
      _s: new Set(),
      add(...names) { names.forEach((name) => this._s.add(name)); },
      remove(...names) { names.forEach((name) => this._s.delete(name)); },
      toggle(name, on) {
        if (on === undefined ? !this._s.has(name) : on) this._s.add(name);
        else this._s.delete(name);
      },
      contains(name) { return this._s.has(name); },
    },
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    fire(type, event) { (listeners[type] || []).forEach((fn) => fn(event || {})); },
    appendChild(child) { this.children.push(child); return child; },
    click() {
      this.fire('click', { preventDefault() {} });
      if (this.onclick) this.onclick({ preventDefault() {} });
    },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML || ''; },
    set(value) {
      el._innerHTML = value;
      el.children = [];
      if (id === 'scene-grid') {
        for (const match of value.matchAll(/<div class="scene-card" data-i="(\d+)">([\s\S]*?)<\/div>\s*<\/div>/g)) {
          const child = makeEl('scene-card');
          child.attrs = { 'data-i': match[1] };
          child.className = 'scene-card';
          child.innerHTML = match[2];
          el.children.push(child);
        }
      } else if (id === 'stepbar') {
        for (const match of value.matchAll(/<span class="seg([^"]*)" data-step="(\d+)"><\/span>/g)) {
          const child = makeEl('seg');
          child.className = 'seg' + match[1];
          child.attrs = { 'data-step': match[2] };
          el.children.push(child);
        }
      }
    },
  });
  return el;
}

function boot(hash) {
  const els = {};
  const docListeners = {};
  let timerId = 0;
  const timers = new Map();
  const documentStub = {
    getElementById(id) {
      return (els[id] = els[id] || makeEl(id));
    },
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
  };
  const setTimer = (fn, ms) => {
    const id = ++timerId;
    timers.set(id, { fn, ms });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const ctx = {
    console, document: documentStub, setTimeout: setTimer, clearTimeout: clearTimer,
    location: { pathname: '/wiki.html', hash: hash || '' },
    history: { replaceState(_state, _title, pathname) { ctx.location.hash = ''; ctx.location.pathname = pathname; } },
    window: {
      addEventListener(type, fn) { (ctx.window._listeners[type] = ctx.window._listeners[type] || []).push(fn); },
      _listeners: {}, scrollTo() {},
    },
  };
  vm.createContext(ctx);
  wikiScript.runInContext(ctx);
  return {
    ctx, els, docListeners, timers,
    key(key) { (docListeners.keydown || []).forEach((fn) => fn({ key, preventDefault() {} })); },
    advanceTimer() {
      const first = timers.keys().next();
      assert.strictEqual(first.done, false, 'a timer is scheduled');
      const item = timers.get(first.value);
      timers.delete(first.value);
      item.fn();
    },
  };
}

test('wiki: index cards render, open scenes, and data is structurally sound', () => {
  const b = boot();
  const { ctx, els } = b;
  assert.strictEqual(els['scene-grid'].children.length, ctx.SCENES.length);
  for (let i = 0; i < ctx.SCENES.length; i++) {
    const card = els['scene-grid'].children[i];
    assert.strictEqual(card.attrs['data-i'], String(i));
    assert.match(card.innerHTML, new RegExp(ctx.SCENES[i].steps.length + ' steps'));
    assert.strictEqual(card.onclick !== undefined, true);
  }
  els['scene-grid'].children[1].click();
  assert.strictEqual(ctx.cur.scene, 1);
  assert.strictEqual(ctx.cur.step, 0);
  assert.ok(els['view-index'].classList.contains('hidden'));
  assert.ok(!els['view-scene'].classList.contains('hidden'));
  assert.strictEqual(ctx.location.hash, '#' + ctx.SCENES[1].id);
  const ids = new Set();
  for (const scene of ctx.SCENES) {
    assert.strictEqual(ids.has(scene.id), false);
    ids.add(scene.id);
    for (const step of scene.steps) {
      assert.ok(step.t && step.n, `${scene.id} step narration`);
      if (step.d) {
        for (const row of step.d.rows) {
          for (const ch of row) {
            if (ch !== '.' && ch !== ' ') assert.ok(step.d.map[ch], `${scene.id} diagram map for ${ch}`);
          }
        }
      }
      for (const link of step.links || []) {
        assert.match(link[1], /^(?:index\.html#[^#]+|#[a-z-]+)$/);
      }
    }
  }
});

test('wiki: steps clamp, render controls, diagrams, chips and completion links', () => {
  const b = boot();
  const { ctx, els } = b;
  ctx.window.openSceneByName(ctx.SCENES[0].id);
  const scene = ctx.SCENES[ctx.cur.scene];
  ctx.showStep(-4);
  assert.strictEqual(ctx.cur.step, 0);
  assert.strictEqual(els['btn-prev'].disabled, true);
  assert.strictEqual(els['btn-next'].disabled, false);
  assert.match(els.stepbar.innerHTML, /cur/);
  els.stepbar.children[1].click();
  assert.strictEqual(ctx.cur.step, 1);
  assert.match(els.stepbar.children[0].className, /done/);
  assert.match(els.stepbar.children[1].className, /cur/);
  assert.strictEqual(els['st-parts'].classList.contains('hidden'), false);
  els.stepbar.children[0].click();
  assert.strictEqual(ctx.cur.step, 0);
  const noParts = scene.steps.findIndex((step) => !step.parts && !step.links);
  if (noParts >= 0) {
    ctx.showStep(noParts);
    assert.strictEqual(els['st-parts'].classList.contains('hidden'), true);
    assert.strictEqual(els['st-try'].classList.contains('hidden'), true);
  }
  ctx.showStep(999);
  assert.strictEqual(ctx.cur.step, scene.steps.length - 1);
  assert.strictEqual(els['btn-next'].disabled, true);
  assert.strictEqual(els['btn-next'].textContent, 'Scene complete');
  assert.match(els['complete-banner'].innerHTML, /Scene complete/);
  assert.match(els['complete-banner'].innerHTML, /Continue with/);
  ctx.window.openSceneByName(ctx.SCENES[ctx.SCENES.length - 1].id);
  ctx.showStep(999);
  assert.match(els['complete-banner'].innerHTML, /Open the studio/);
  assert.strictEqual(ctx.renderDiagram(null), '');
  const diagram = ctx.renderDiagram({ rows: ['A. ', ' BB'], map: { A: ['red', 'alpha'], B: ['blue', 'beta'] }, legend: [['red', 'alpha']] });
  assert.strictEqual((diagram.match(/class="cell/g) || []).length, 6);
  assert.match(diagram, /title="alpha"/);
  assert.match(diagram, /background:blue/);
  assert.strictEqual((diagram.match(/class="legend"/g) || []).length, 1);
});

test('wiki: autoplay, pause, keyboard controls and index no-op behavior', () => {
  const b = boot();
  const { ctx, els } = b;
  const scene = ctx.SCENES[0];
  ctx.window.openSceneByName(scene.id);
  els['btn-play'].click();
  assert.strictEqual(ctx.cur.playing, true);
  assert.match(els['btn-play'].innerHTML, /Pause/);
  b.advanceTimer();
  assert.strictEqual(ctx.cur.step, 1);
  els['btn-play'].click();
  assert.strictEqual(ctx.cur.playing, false);
  assert.match(els['btn-play'].innerHTML, /Play/);
  els['btn-play'].click();
  while (ctx.cur.playing) b.advanceTimer();
  assert.strictEqual(ctx.cur.step, scene.steps.length - 1);
  assert.match(els['btn-play'].innerHTML, /Play/);
  ctx.showStep(0);
  b.key('ArrowRight');
  assert.strictEqual(ctx.cur.step, 1);
  b.key('ArrowLeft');
  assert.strictEqual(ctx.cur.step, 0);
  b.key(' ');
  assert.strictEqual(ctx.cur.playing, true);
  els['btn-play'].click();
  ctx.showIndex();
  const step = ctx.cur.step;
  b.key('ArrowRight');
  b.key(' ');
  assert.strictEqual(ctx.cur.step, step);
  assert.strictEqual(ctx.cur.playing, false);
  assert.strictEqual(ctx.location.hash, '');
});

test('wiki: scene routing handles valid, unknown and malformed hashes', () => {
  const b = boot('#unknown-scene');
  const { ctx, els } = b;
  assert.strictEqual(ctx.cur.scene, -1);
  ctx.location.hash = '#workshop';
  ctx.routeScene();
  assert.strictEqual(ctx.cur.scene, 0);
  ctx.location.hash = '#not-a-scene';
  ctx.routeScene();
  assert.strictEqual(ctx.cur.scene, 0);
  ctx.location.hash = '#bad_hash!';
  ctx.routeScene();
  assert.strictEqual(ctx.cur.scene, 0);
  ctx.window.openSceneByName('not-real');
  assert.ok(!els['view-index'].classList.contains('hidden'));
  assert.ok(els['view-scene'].classList.contains('hidden'));
});
