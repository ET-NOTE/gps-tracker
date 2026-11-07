import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';import * as React from 'react';import * as jsx from 'react/jsx-runtime';import {create,act} from 'react-test-renderer';import {transform} from 'esbuild';
async function components(api={},queries={}){
 const context=vm.createContext({console,window:{addEventListener(){},removeEventListener(){}}});const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
 const s=await readFile(new URL('../src/components/PrivacyRedacted.jsx',import.meta.url),'utf8');const m=new vm.SourceTextModule((await transform(s,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
 await m.link(n=>{if(n==='react')return moduleOf(React);if(n==='react/jsx-runtime')return moduleOf(jsx);if(n==='../api')return moduleOf({api});if(n==='../lib/fileDownload')return moduleOf({saveBlob:async()=>{}});if(n==='@tanstack/react-query')return moduleOf({useQuery:({queryKey})=>({data:queries[queryKey[0]],refetch:async()=>{}})});throw Error(n);});await m.evaluate();return m.namespace;
}
test('Unicode selection uses scalar offsets rather than UTF16',async()=>{const m=await components();assert.deepEqual(JSON.parse(JSON.stringify(m.selectedRange('가😀비밀',0,3))),{start:0,end:2});});
test('no text selected by default; preview and confirmation invalidate on scope changes',async()=>{
 let sent;const {AdminRedacted}=await components({reviewPrivacyText:async()=>({body:'가😀비밀끝',source_kind:'chat',source_id:3,source_sha256:'abc'}),previewRedacted:async(id,b)=>{sent=b;return{text:'가😀[비공개]',notice:b.notice,preview_sha256:'hash'};}},{'privacy-text-sources':{items:[{id:3,supported:true,created_at:'2026-11-05',characters:5}]},'admin-redacted':{items:[],events:[]}});
 let r;await act(async()=>{r=create(React.createElement(AdminRedacted,{request:{id:1,revision:2,status:'in_review',due_at:'2099-01-01'}}),{createNodeMock:el=>el.type==='textarea'?{selectionStart:0,selectionEnd:3}:null});});
 const button=text=>r.root.findAllByType('button').find(x=>x.children.includes(text));
 await act(async()=>r.root.findAllByType('button')[0].props.onClick());assert.equal(button('제공본 미리보기').props.disabled,true);
 await act(async()=>button('선택한 부분만 추가').props.onClick());await act(async()=>r.root.findAllByType('textarea')[1].props.onChange({target:{value:'타인 정보 제외'}}));
 await act(async()=>button('제공본 미리보기').props.onClick());assert.equal(sent.ranges[0].end,2);assert.equal(button('24시간 제공 권한 발급').props.disabled,true);
 await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));assert.equal(button('24시간 제공 권한 발급').props.disabled,false);
 await act(async()=>r.root.findAllByType('textarea')[1].props.onChange({target:{value:'새 범위'}}));assert.equal(button('24시간 제공 권한 발급'),undefined);
 await act(async()=>r.unmount());
});
test('cancelled requests offer no downloads and errors never claim saved',async()=>{
 const {PersonalRedacted}=await components({downloadRedacted:async()=>{throw Error('원문 변경');}},{'personal-redacted':{items:[{id:1,source_kind:'chat',notice:'일부',expires_at:'2099-01-01'}]}});let r;
 await act(async()=>{r=create(React.createElement(PersonalRedacted,{request:{id:1,revision:2,status:'cancelled'}}));});assert.equal(r.root.findAllByType('input').length,0);assert.equal(r.root.findAllByType('button').length,0);
 await act(async()=>r.update(React.createElement(PersonalRedacted,{request:{id:1,revision:3,status:'in_review'}})));await act(async()=>r.root.findByType('input').props.onChange({target:{value:'test-only'}}));await act(async()=>r.root.findByType('button').props.onClick());assert.equal(r.root.findByType('input').props.value,'');assert.match(JSON.stringify(r.toJSON()),/원문 변경/);assert.equal(r.root.findAllByProps({role:'status'}).length,0);await act(async()=>r.unmount());
});
