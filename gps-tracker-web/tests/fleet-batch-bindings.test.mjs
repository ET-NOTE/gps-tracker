import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act, create} from 'react-test-renderer';
import {transform} from 'esbuild';
import {fleetAssetLabel} from '../src/lib/fleetAssets.js';

const text = node => Array.isArray(node) ? node.map(text).join('') : typeof node === 'string' || typeof node === 'number' ? String(node) : text(node?.children || []);
const checkbox = (tree, index) => tree.root.findAllByType('input')[index];
const button = (tree, label) => tree.root.find(n => n.type === 'button' && text(n.children) === label);
const click = async (tree, label) => act(async () => button(tree, label).props.onClick());
const choose = async (tree, label, value) => act(async () => tree.root.findByProps({'aria-label': label}).props.onChange({target: {value}}));

async function mount(t, connect = async () => {}) {
  const code = (await transform(await readFile(new URL('../src/components/business/FleetBatchBindings.jsx', import.meta.url), 'utf8'), {loader: 'jsx', jsx: 'automatic', format: 'esm'})).code;
  const context = vm.createContext({});
  const calls = [];
  let refreshed = 0;
  const Modal = ({children, footer}) => React.createElement('section', {role:'dialog'}, children, footer);
  const imports = {'react':React, 'react/jsx-runtime':jsx, '../ui':{Modal}, '../../lib/fleetAssets':{fleetAssetLabel},
    '../../api':{api:{connectFleetVehicles: async body => {calls.push(JSON.parse(JSON.stringify(body))); await connect();}}}};
  const mod = new vm.SourceTextModule(code, {context});
  await mod.link(name => {
    const exports = imports[name] || {};
    return new vm.SyntheticModule(Object.keys(exports), function(){for (const [key, val] of Object.entries(exports)) this.setExport(key, val);}, {context});
  });
  await mod.evaluate();
  const assets = [1, 2, 3, 4].map(id => ({
    id, name:`차량${id}`, license_plate:`번호${id}`, updated_at:`버전${id}`,
    bindings: id === 4 ? [] : [{device_id:id + 10, is_primary:true, terminal_name:`단말${id}`}],
  }));
  // The third binding has no corresponding telemetry, fourth device is unassigned.
  const devices = [1, 2, 4].map(id => ({id:id + 10, display_name:`단말${id}`}));
  let tree;
  await act(async () => {tree = create(React.createElement(mod.namespace.default, {assets, devices, onChanged:() => refreshed++}));});
  t.after(async () => act(async () => tree.unmount()));
  await click(tree, '단말기 일괄 연결');
  return {tree, calls, refreshed:() => refreshed};
}

async function selectVehicles(tree, ...indexes) {
  for (const index of indexes) await act(async () => checkbox(tree, index).props.onChange({target:{checked:true}}));
  await click(tree, '단말기 배정');
}

test('review a two-vehicle swap and choose a primary before committing one versioned request', async t => {
  const {tree, calls, refreshed} = await mount(t);
  await selectVehicles(tree, 0, 1, 3);
  assert.equal(button(tree, '변경 확인').props.disabled, true);
  assert.equal(tree.root.findAllByProps({'aria-label':'단말3 연결 차량'}).length, 0);
  await choose(tree, '단말1 연결 차량', '2');
  await choose(tree, '단말2 연결 차량', '1');
  await choose(tree, '단말4 연결 차량', '1');
  await choose(tree, '차량1 · 번호1 대표 단말기', '14');
  await click(tree, '변경 확인');
  assert.equal(calls.length, 0);
  assert.match(text(tree.root), /단말4 \(대표\)/);
  await click(tree, '차량 2대 저장');
  assert.deepEqual(calls,[{vehicles:[
    {vehicle_id:1, updated_at:'버전1', device_ids:[12,14], primary_device_id:14},
    {vehicle_id:2, updated_at:'버전2', device_ids:[11], primary_device_id:11},
  ]}]);
  assert.equal(refreshed(),1);
  assert.equal(tree.root.findAllByProps({role:'dialog'}).length,0);
});

test('bound terminal without telemetry remains in the plan; failed save retains review and cancel never writes', async t => {
  const {tree, calls, refreshed} = await mount(t, async () => {throw Error('차량 연결이 변경됐습니다.');});
  await selectVehicles(tree, 2, 3);
  await choose(tree, '단말3 연결 차량', '4');
  await click(tree, '변경 확인');
  await click(tree, '차량 2대 저장');
  assert.equal(refreshed(),0);
  assert.match(text(tree.root.findByProps({role:'alert'})), /변경됐습니다/);
  assert.deepEqual(calls[0].vehicles, [
    {vehicle_id:3, updated_at:'버전3', device_ids:[], primary_device_id:null},
    {vehicle_id:4, updated_at:'버전4', device_ids:[13], primary_device_id:13},
  ]);
  await click(tree, '이전');
  assert.equal(tree.root.findByProps({'aria-label':'단말3 연결 차량'}).props.value,4);
  await click(tree, '취소');
  assert.equal(calls.length,1);
});
