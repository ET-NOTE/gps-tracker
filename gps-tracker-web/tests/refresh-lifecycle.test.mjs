import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as React from 'react';
import { act, create } from 'react-test-renderer';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(file) {
  let now = 100_000, seq = 0;
  const timers = new Map(), window = new EventTarget(), document = new EventTarget(); document.visibilityState = 'visible';
  const context = vm.createContext({ console, window, document, Date: { now: () => now },
    setInterval: fn => { timers.set(++seq, fn); return seq; }, clearInterval: id => timers.delete(id) });
  const react = new vm.SyntheticModule(Object.keys(React), function() { for (const [k, v] of Object.entries(React)) this.setExport(k, v); }, { context });
  const mod = new vm.SourceTextModule(await readFile(new URL(`../src/hooks/${file}.js`, import.meta.url), 'utf8'), { context });
  await mod.link(() => react); await mod.evaluate();
  return { hooks: mod.namespace, timers, window, document, tick: () => { now += 1000; for (const fn of [...timers.values()]) fn(); } };
}

test('speed clock only rerenders its consumer, suspends when hidden, and cleans up', async () => {
  const f = await fixture('useVisibleNow'); let parentRenders = 0, childRenders = 0, r;
  function Child({ enabled }) { childRenders++; return React.createElement('span', {}, f.hooks.useVisibleNow(enabled)); }
  function Parent({ enabled = true }) { parentRenders++; return React.createElement(Child, { enabled }); }
  await act(async () => { r = create(React.createElement(Parent)); });
  const before = childRenders;
  await act(async () => f.tick());
  assert.equal(parentRenders, 1); assert.equal(childRenders, before + 1);
  await act(async () => { f.document.visibilityState = 'hidden'; f.document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(f.timers.size, 0);
  await act(async () => { f.tick(); f.document.visibilityState = 'visible'; f.document.dispatchEvent(new Event('visibilitychange')); });
  assert.equal(r.root.findByType('span').children[0], '102000'); assert.equal(f.timers.size, 1);
  await act(async () => r.update(React.createElement(Parent, { enabled: false })));
  assert.equal(f.timers.size, 0);
  await act(async () => r.unmount());
  f.document.dispatchEvent(new Event('visibilitychange')); assert.equal(f.timers.size, 0);
});

test('refresh coalesces forced retries without overlapping; hidden intervals and unmounted queues stop', async () => {
  const f = await fixture('useAutoRefresh'), work = [deferred(), deferred(), deferred()];
  const calls = []; let refresh, r;
  function Probe() { refresh = f.hooks.useAutoRefresh(force => { calls.push(force); return work[calls.length - 1].promise; }); return null; }
  await act(async () => { r = create(React.createElement(Probe)); });
  let first;
  await act(async () => { first = refresh(true); });
  refresh(true); refresh(true); refresh(true);
  assert.equal(calls.length, 1);
  await act(async () => work[0].resolve());
  assert.deepEqual(calls, [true, true], 'three queued requests produce one serialized refresh');
  await act(async () => work[1].resolve()); await first;
  await act(async () => { f.document.visibilityState = 'hidden'; f.tick(); });
  assert.equal(calls.length, 2);
  await act(async () => { refresh(true); }); refresh(true);
  await act(async () => r.unmount()); work[2].resolve(); await Promise.resolve();
  assert.equal(f.timers.size, 0); assert.equal(calls.length, 3);
});
