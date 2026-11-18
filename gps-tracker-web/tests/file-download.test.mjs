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
 return {save:mod.namespace.saveBlob,message:mod.namespace.fileSaveMessage,window,links,revoked,timers};
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
 const failed=await fixture(async()=>({ok:false}));await assert.rejects(failed.save(new Blob(['x'],{type:'text/csv'}),'r.csv'),/저장하거나/);assert.equal(failed.links.length,0);
 let called=false;const large=await fixture(async()=>{called=true;});await assert.rejects(large.save(new Blob([new Uint8Array(8*1024*1024+1)],{type:'text/csv'}),'r.csv'),/너무 큽니다/);assert.equal(called,false);
});

test('v2 exports all nine supported formats byte-for-byte; v1 requires update for new types',async()=>{
 const fixtures=JSON.parse(await readFile(new URL('./fixtures/android-files.json',import.meta.url),'utf8'));
 for(const item of fixtures){
  const bytes=Buffer.from(item.base64,'base64'),blob=new Blob([bytes],{type:item.mime});
  const calls=[],f=await fixture(async request=>{calls.push(request);return{ok:true,status:'saved'};});
  Object.assign(f.window.GpsFiles,{version:2,mimeTypes:fixtures.map(f=>f.mime),maxBytes:8*1024*1024});
  await f.save(blob,'가🚗'.repeat(80)+item.filename);
  assert.equal(calls[0].base64,item.base64);assert.equal(calls[0].mime,item.mime);
  assert.ok(calls[0].filename.endsWith(item.filename.match(/\.[^.]+$/)[0]));
  assert.ok(Buffer.byteLength(calls[0].filename)<=255);assert.equal(f.links.length,0);
  if(!['text/csv','application/pdf'].includes(item.mime)){
   const old=await fixture(()=>assert.fail('old bridge must not receive new formats'));
   await assert.rejects(old.save(blob,item.filename),/최신 앱/);assert.equal(old.links.length,0);
  }
 }
});
test('empty, busy, unknown result and smaller advertised limit remain explicit failures',async()=>{
 const f=await fixture(async()=>({ok:true,status:'unknown'})),blob=new Blob(['x'],{type:'text/csv'});
 await assert.rejects(f.save(blob,'file.csv'),/결과/);
 await assert.rejects(f.save(new Blob([],{type:'text/csv'}),'file.csv'),/비어/);
 f.window.GpsFiles.exportReport=async()=>({ok:false,error:'busy'});
 await assert.rejects(f.save(blob,'file.csv'),/처리 중/);
 f.window.GpsFiles.maxBytes=1;
 await assert.rejects(f.save(new Blob(['xx'],{type:'text/csv'}),'file.csv'),/너무 큽니다/);
 assert.match(f.message({status:'cancelled'}),/취소/);
 assert.match(f.message({status:'share_opened'}),/공유 화면/);
 assert.match(f.message({status:'saved'}),/저장했습니다/);
 assert.match(f.message({status:'browser_started'}),/요청했습니다/);
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
