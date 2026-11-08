import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

test('queue panel clears stale success on failure, recovers and distinguishes disabled delivery',async()=>{
 let failed=false,off=false,poll,cleared=false;
 const context=vm.createContext({console,setInterval:f=>{poll=f;return 1;},clearInterval:()=>{cleared=true;}});
 const code=(await transform(await readFile(new URL('../src/components/NoticeQueuePanel.jsx',import.meta.url),'utf8'),{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const mod=new vm.SourceTextModule(code,{context});
 const synthetic=values=>new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});
 await mod.link(name=>name==='react'?synthetic(React):name==='react/jsx-runtime'?synthetic(jsx):synthetic({api:{adminNoticeQueue:async()=>{
  if(failed)throw Error('private DSN must not be shown');
  return {expected_running:!off,enabled:!off,push_enabled:!off,severity:'ok',checked_at:'2026-11-08T00:00:00Z',pending:0,inflight:0,review:0,accepted_5m:1200,failed_5m:0,oldest_pending_seconds:0,alerts:[]};
 }}}));await mod.evaluate();let r;
 await act(async()=>{r=create(React.createElement(mod.namespace.default));});
 assert.match(JSON.stringify(r.toJSON()),/정상 처리 중/);
 assert.match(JSON.stringify(r.toJSON()),/휴대폰 도착·읽음 여부와 다릅니다/);
 failed=true;await act(async()=>poll());
 assert.match(JSON.stringify(r.toJSON()),/불러오지 못했습니다/);assert.doesNotMatch(JSON.stringify(r.toJSON()),/정상 처리 중|1200|private DSN/);
 failed=false;off=true;await act(async()=>r.root.findByType('button').props.onClick());
 assert.match(JSON.stringify(r.toJSON()),/발송 꺼짐/);
 await act(async()=>r.unmount());assert.equal(cleared,true);
});
