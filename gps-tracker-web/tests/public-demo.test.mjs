import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { demoVehicles, demoPointTime } from '../src/components/demo/demoVehicles.js';
import { demoTarget, demoHref, referenceTarget } from '../src/components/demo/referenceNavigation.js';
import { bootDocument, bootstrapMarker, endSampleSession, readSampleSession, writeSampleSession } from '../src/components/demo/referenceSession.js';

test('opening the public demo cannot initialize the real account client or phone tracker', async () => {
  const result = await build({
    absWorkingDir: fileURLToPath(new URL('..', import.meta.url)),
    entryPoints: ['src/pages/DemoWorkspace.jsx'],
    bundle: true, packages: 'external', write: false, metafile: true, outdir: 'out',
  });
  const modules = Object.keys(result.metafile.inputs).map(p => p.replaceAll('\\', '/'));
  const privateModules = modules.filter(p => /^src\/(api\.js|authSession\.js|state\/|lib\/phoneTracker\.js|pages\/Dashboard\.jsx)$/.test(p) || p.startsWith('src/state/'));
  assert.deepEqual(privateModules, []);
});

test('each demo vehicle has a distinct route and playback reaches its displayed arrival time', () => {
  assert.equal(new Set(demoVehicles.map(v => v.id)).size, demoVehicles.length);
  for (const vehicle of demoVehicles) {
    assert.ok(vehicle.points.length > 1);
    assert.equal(demoPointTime(vehicle, 0), vehicle.start);
    assert.equal(demoPointTime(vehicle, vehicle.points.length - 1), vehicle.end);
  }
});

test('workspace links preserve service context and previously shared demo links', () => {
  for (const [path, search, route, service] of [
    ['/demo', '', 'platform-home', 'platform'],
    ['/demo/rentcar', '?page=fleet', 'rent-vehicles', 'rental'],
    ['/demo/cargo', '?page=orders', 'cargo-orders', 'cargo'],
    ['/demo/corporate', '?page=expenses', 'expenses', 'corporate'],
    ['/demo/cargo', '?view=users', 'users', 'cargo'],
    ['/demo/corporate', '?view=cargo-orders', 'dashboard', 'corporate'],
    ['/demo', '?view=constructor', 'platform-home', 'platform'],
  ]) {
    const target = demoTarget(path, search);
    assert.deepEqual(target, {route, service});
    const url = new URL(demoHref(target), 'https://example.test');
    assert.deepEqual(demoTarget(url.pathname, url.search), target);
  }
  assert.equal(referenceTarget('https://example.test', 'cargo'), null);
});

test('sample edits survive a refresh in the tab, exclude account data and clear on exit', () => {
  const data = new Map([['auth_session', 'existing-account']]);
  const storage = {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  };
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {configurable: true, value: storage});
  try {
    const key = 'seriallink-fleet-prototype-v1';
    const sample = JSON.stringify({name: '</script><b>화물</b>'});
    assert.equal(writeSampleSession({[key]: sample, access_token: 'must-be-ignored'}), true);
    assert.deepEqual(readSampleSession(), {[key]: sample});
    const html = bootDocument(bootstrapMarker, demoTarget('/demo', ''), readSampleSession());
    assert.equal(html.includes('</script><b>'), false);
    assert.equal(html.includes('must-be-ignored'), false);
    assert.equal(html.match(/<\/script>/g).length, 1);
    endSampleSession();
    assert.deepEqual(readSampleSession(), {});
    assert.deepEqual([...data.entries()], [['auth_session','existing-account']]);
    assert.throws(() => bootDocument('<html></html>', {}, {}));
  } finally {
    if (previous) Object.defineProperty(globalThis, 'sessionStorage', previous);
    else delete globalThis.sessionStorage;
  }
});

test('sample forms can submit to local handlers while the document prohibits outbound requests', async () => {
  const root = new URL('../', import.meta.url);
  const host = await readFile(new URL('src/components/demo/ReferenceFrame.jsx', root), 'utf8');
  const template = await readFile(new URL('public/fleet-preview/fleet-v1.html', root), 'utf8');
  const sandbox = host.match(/sandbox="([^"]+)"/)[1].split(' ');
  assert.ok(sandbox.includes('allow-forms'));
  assert.ok(sandbox.includes('allow-scripts'));
  assert.ok(!sandbox.includes('allow-same-origin'));
  assert.ok(!sandbox.includes('allow-top-navigation'));
  const policy = template.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/i)[1];
  for (const directive of ["connect-src 'none'", "form-action 'none'", "object-src 'none'", "frame-src 'none'"]) {
    assert.ok(policy.split(';').map(rule => rule.trim()).includes(directive));
  }
});
