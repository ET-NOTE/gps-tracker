import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
async function fixture() {
  const scripts=[], timeouts=new Map(); let timer=0;
  const document={querySelector:()=>scripts[0]||null, querySelectorAll:()=>scripts.slice(),
    createElement:()=>{const s=new EventTarget();s.dataset={};s.remove=()=>{const i=scripts.indexOf(s);if(i>=0)scripts.splice(i,1);};return s;}, head:{appendChild:s=>scripts.push(s)}};
  const window={};
  const context=vm.createContext({window,document,Promise,Error,
    setTimeout:fn=>{timeouts.set(++timer,fn);return timer;}, clearTimeout:id=>timeouts.delete(id),setInterval:()=>++timer,clearInterval(){}});
  const mod=new vm.SourceTextModule(await readFile(new URL('../src/lib/kakaoSdk.js',import.meta.url),'utf8'),{context});
  await mod.link(()=>{}); await mod.evaluate();
  return {sdk:mod.namespace,window,scripts,timeout:()=>{for(const fn of [...timeouts.values()])fn();}};
}
test('SDK: maps share load; network failure permits fresh script injection',async()=>{
  const f=await fixture();const a=f.sdk.loadKakaoMaps(), b=f.sdk.loadKakaoMaps();
  assert.equal(a,b);assert.equal(f.scripts.length,1);
  const rejected=assert.rejects(a,/지도를/);f.scripts[0].dispatchEvent(new Event('error'));await rejected;
  assert.equal(f.scripts.length,0);
  const retry=f.sdk.loadKakaoMaps();assert.equal(f.scripts.length,1);
  f.window.kakao={maps:{Map:class{}}};f.scripts[0].dispatchEvent(new Event('load'));assert.equal(await retry,f.window.kakao);
});
test('SDK: script and initialization have bounded timeouts and recover',async()=>{
  const f=await fixture();const a=f.sdk.loadKakaoMaps(), failed=assert.rejects(a);
  f.timeout();await failed;assert.equal(f.scripts.length,0);
  const b=f.sdk.loadKakaoMaps(), stalled=assert.rejects(b,/초과/);
  f.window.kakao={maps:{load:()=>{}}};f.scripts[0].dispatchEvent(new Event('load'));
  await new Promise(resolve => setImmediate(resolve));f.timeout();await stalled;
  assert.equal(f.window.kakao,undefined);assert.equal(f.scripts.length,0);
  const c=f.sdk.loadKakaoMaps();f.window.kakao={maps:{Map:class{}}};f.scripts[0].dispatchEvent(new Event('load'));await c;
});
