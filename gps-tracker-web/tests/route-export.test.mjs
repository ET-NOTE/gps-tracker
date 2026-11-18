import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
test('route exports use native-capable saver, escape GPX labels and propagate cancel/failure',async()=>{
 const calls=[],context=vm.createContext({Blob});let outcome={status:'cancelled'};
 const m=new vm.SourceTextModule(await readFile(new URL('../src/lib/routeExport.js',import.meta.url),'utf8'),{context});
 await m.link(()=>new vm.SyntheticModule(['saveBlob'],function(){this.setExport('saveBlob',async(blob,filename)=>{calls.push({blob,filename});if(outcome instanceof Error)throw outcome;return outcome;});},{context}));await m.evaluate();
 const points=[{lat:37,lng:127,recorded_at:'2026-11-01T00:00:00Z',_speed:36}];
 assert.equal((await m.namespace.exportGpx(points,'A&B<차량>.gpx')).status,'cancelled');
 assert.equal(calls[0].blob.type,'application/gpx+xml');assert.match(await calls[0].blob.text(),/A&amp;B&lt;차량&gt;/);
 await m.namespace.exportCsv(points,'route.csv');assert.equal(calls[1].blob.type,'text/csv;charset=utf-8');
 assert.match(await calls[1].blob.text(),/37,127,36.0/);
 outcome=Error('busy');await assert.rejects(m.namespace.exportCsv(points,'route.csv'),/busy/);
});
