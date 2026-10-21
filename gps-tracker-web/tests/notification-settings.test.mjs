import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import { create, act } from 'react-test-renderer';
import { transform } from 'esbuild';

const settings = { signal_loss_minutes: 5, offline_minutes: 1440, low_batt_threshold_mv: 3500, motion_alert: true };
async function component(api) {
  const context = vm.createContext({ console });
  const source = await readFile(new URL('../src/components/NotificationSettings.jsx', import.meta.url), 'utf8');
  const m = new vm.SourceTextModule((await transform(source, {loader:'jsx', jsx:'automatic', format:'esm'})).code, {context});
  async function link(name) {
    if (name === './ui/Switch') {
      const code = await readFile(new URL('../src/components/ui/Switch.jsx', import.meta.url), 'utf8');
      const child = new vm.SourceTextModule((await transform(code, {loader:'jsx', jsx:'automatic', format:'esm'})).code, {context});
      await child.link(link); return child;
    }
    const values = name === 'react' ? React : name === 'react/jsx-runtime' ? jsx : {api};
    return new vm.SyntheticModule(Object.keys(values), function() { for (const [k,v] of Object.entries(values)) this.setExport(k,v); }, {context});
  }
  await m.link(link);
  await m.evaluate();
  return m.namespace.default;
}
test('failed save restores the stored preference and prevents overlapping edits', async () => {
  let reject, calls = 0;
  const C = await component({ getNotificationSettings: async () => settings,
    updateNotificationSettings: () => { calls++; return new Promise((_,r) => { reject=r; }); } });
  let r; await act(async () => { r=create(React.createElement(C)); });
  const toggle = () => r.root.findAllByProps({role:'switch'}).find(x => x.props['aria-label']==='움직임으로 깨어남');
  await act(async () => { toggle().props.onClick(); });
  assert.equal(r.root.findByType('fieldset').props.disabled, true);
  await act(async () => { toggle().props.onClick(); });
  assert.equal(calls,1);
  await act(async () => reject(Error('offline')));
  assert.equal(toggle().props['aria-checked'],true);
  assert.equal(r.root.findByType('fieldset').props.disabled,false);
  assert.match(JSON.stringify(r.toJSON()),/이전 값으로 되돌렸습니다/);
  await act(async () => r.unmount());
});
test('load failure offers retry and copy distinguishes GPS acquisition from driving', async () => {
  let calls=0;
  const C=await component({getNotificationSettings:async () => { if (++calls===1) throw Error('offline'); return settings; }});
  let r; await act(async () => { r=create(React.createElement(C)); });
  assert.match(JSON.stringify(r.toJSON()),/불러오지 못했습니다/);
  await act(async () => r.root.findByType('button').props.onClick());
  assert.match(JSON.stringify(r.toJSON()),/실제 이동을 뜻하지는 않습니다/);
  assert.doesNotMatch(JSON.stringify(r.toJSON()),/backend|브라운아웃|운행 시작/);
  await act(async () => r.unmount());
});

test('connection notice offers a 24-hour default and persists a chosen delay without promising daily repeats', async () => {
  let update;
  const C = await component({getNotificationSettings: async () => settings,
    updateNotificationSettings: async patch => {update=patch; return {...settings,...patch};}});
  let r; await act(async () => {r=create(React.createElement(C));});
  assert.match(JSON.stringify(r.toJSON()), /24시간 미수신 시 한 번 안내/);
  assert.match(JSON.stringify(r.toJSON()), /다시 수신될 때까지 반복하지 않습니다/);
  const select=()=>r.root.findByType('select');
  assert.equal(select().props.value,1440);
  await act(async () => {select().props.onChange({target:{value:'2880'}});});
  assert.equal(update.offline_minutes,2880);
  assert.equal(select().props.value,2880);
  assert.match(JSON.stringify(r.toJSON()), /2일 미수신 시 한 번 안내/);
  await act(async () => r.unmount());
});


test('regular status reporting uses the persisted wake preference, independently of motion',async()=>{
 let stored={...settings,wake_alert:false},sent;
 const C=await component({getNotificationSettings:async()=>stored,updateNotificationSettings:async update=>{sent=update;stored={...stored,...update};return stored;}});
 let r;await act(async()=>{r=create(React.createElement(C));});
 const toggle=()=>r.root.findAllByProps({role:'switch'}).find(x=>x.props['aria-label']==='전원 켜짐·정기 상태 보고');
 assert.equal(toggle().props['aria-checked'],false);
 await act(async()=>toggle().props.onClick());assert.equal(sent.wake_alert,true);assert.equal(stored.motion_alert,true);
 await act(async()=>toggle().props.onClick());assert.equal(sent.wake_alert,false);
 assert.match(JSON.stringify(r.toJSON()),/24시간/);assert.match(JSON.stringify(r.toJSON()),/펌웨어 갱신/);
 await act(async()=>r.unmount());
});
