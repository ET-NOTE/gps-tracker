import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {safeFilename} from '../src/lib/businessExport.js';
async function fixture(native = null) {
 const window=new EventTarget(), links=[], revoked=[], timers=[];
 if(native)window.GpsFiles={version:1,exportReport:native};
 const document={createElement:()=>({click(){links.push(this);},remove(){}}),body:{appendChild(){}}};
 const context=vm.createContext({window,document,Blob,Uint8Array,btoa,
  URL:{createObjectURL:()=> 'blob:fixture',revokeObjectURL:u=>revoked.push(u)},
  setTimeout:fn=>{timers.push(fn);return timers.length;},clearTimeout(){}});
 const mod=new vm.SourceTextModule(await readFile(new URL('../src/lib/fileDownload.js',import.meta.url),'utf8'),{context});
 await mod.link(()=>new vm.SyntheticModule(['safeFilename'],function(){this.setExport('safeFilename',safeFilename);},{context}));await mod.evaluate();
 return {save:mod.namespace.saveBlob,window,links,revoked,timers};
}
test('native export preserves Korean CSV and only supplies filename, MIME and bytes',async()=>{
 const calls=[],f=await fixture(async request=>{calls.push(request);return{ok:true,status:'saved'};});
 const blob=new Blob(['\uFEFF차량,거리\n가상차량,42'],{type:'text/csv;charset=utf-8'});
 const result=await f.save(blob,'운행/기록.csv');assert.equal(result.status,'saved');assert.equal(f.links.length,0);
 assert.deepEqual(Object.keys(calls[0]).sort(),['base64','filename','mime']);assert.equal(calls[0].filename,'운행_기록.csv');
 assert.equal(calls[0].mime,'text/csv');assert.deepEqual(Buffer.from(calls[0].base64,'base64'),Buffer.from(await blob.arrayBuffer()));
});
test('cancel/share-opening are honest outcomes; failures and oversized files never fall back silently',async()=>{
 for(const status of ['cancelled','share_opened']){const f=await fixture(async()=>({ok:true,status}));assert.equal((await f.save(new Blob(['%PDF-1.4'],{type:'application/pdf'}),'r.pdf')).status,status);}
 const failed=await fixture(async()=>({ok:false}));await assert.rejects(failed.save(new Blob(['x']),'r.csv'),/저장하거나/);assert.equal(failed.links.length,0);
 let called=false;const large=await fixture(async()=>{called=true;});await assert.rejects(large.save(new Blob([new Uint8Array(8*1024*1024+1)]),'r.csv'),/너무 큽니다/);assert.equal(called,false);
});
test('browser fallback starts a named download and later revokes its object URL',async()=>{
 const f=await fixture();assert.equal((await f.save(new Blob(['data']),'report.csv')).status,'browser_started');
 assert.equal(f.links[0].download,'report.csv');f.timers[0]();assert.deepEqual(f.revoked,['blob:fixture']);
});
test('old app gets update guidance rather than an unsupported blob navigation',async()=>{
 const f=await fixture();f.window.FlutterAppOpenUrl={};await assert.rejects(f.save(new Blob(['data']),'report.csv'),/최신 앱/);assert.equal(f.links.length,0);
});

test('long Korean/emoji filenames retain report extension within filesystem limits',async()=>{
 const calls=[],f=await fixture(async payload=>{calls.push(payload);return{ok:true,status:'saved'};});
 await f.save(new Blob(['csv'],{type:'text/csv'}),'가상차량🚗'.repeat(40)+'.csv');
 assert.ok(calls[0].filename.endsWith('.csv'));assert.ok(Buffer.byteLength(calls[0].filename,'utf8')<=255);
});
