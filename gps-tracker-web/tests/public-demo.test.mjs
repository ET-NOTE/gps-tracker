import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { demoVehicles, demoPointTime } from '../src/components/demo/demoVehicles.js';

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
