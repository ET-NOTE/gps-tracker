import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
async function components(api={},queries={}) {
 const context=vm.createContext({console});
 const source=await readFile(new URL('../src/components/PrivacyAccountPackage.jsx',import.meta.url),'utf8');
 const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
 const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
 await m.link(name=>{
  if(name==='react')return moduleOf(React);if(name==='react/jsx-runtime')return moduleOf(jsx);
  if(name==='../api')return moduleOf({api});
  if(name==='../lib/fileDownload')return moduleOf({saveBlob:async()=>{}});
  if(name==='./PrivacyDelivery')return moduleOf({deliveryState:p=>p.revoked_at?'회수됨':'다운로드 가능'});
  if(name==='@tanstack/react-query')return moduleOf({useQuery:({queryKey})=>({data:queries[queryKey[0]],refetch:async()=>{}})});
  throw Error(name);
 });await m.evaluate();return m.namespace;
}
const request={id:5,revision:7,status:'in_review',due_at:'2099-01-01'};
const document={id:10,filename:'personal.pdf',size_bytes:42,mime:'application/pdf'};
test('document selection requires downloaded review and attestation; issue carries digest and revision',async()=>{
 let sent;const {AdminAccountPackages}=await components({reviewPrivacyDocument:async()=>({blob:'file',sha256:'a'.repeat(64)}),issuePrivacyAccountPackage:async(id,body)=>{sent={id,...body};}}, {'admin-personal-documents':{items:[document]},'admin-account-packages':{items:[],events:[]}});let r;
 await act(async()=>{r=create(React.createElement(AdminAccountPackages,{request,refresh:async()=>{}}));});
 assert.equal(r.root.findAllByProps({type:'checkbox'})[0].props.disabled,true);
 await act(async()=>r.root.findAllByType('button').find(b=>b.children.join('')==='서류 내려받아 검토').props.onClick());
 await act(async()=>r.root.findAllByProps({type:'checkbox'})[0].props.onChange({target:{checked:true}}));
 assert.equal(r.root.findByProps({type:'submit'}).props.disabled,true);
 await act(async()=>r.root.findAllByProps({type:'checkbox'}).at(-1).props.onChange({target:{checked:true}}));
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(sent.revision,7);assert.equal(sent.documents[0].sha256,'a'.repeat(64));assert.equal(sent.documents[0].id,10);assert.equal(sent.confirmed,true);
 await act(async()=>r.unmount());
});
test('optional sections start empty, changing scope clears attestation, old grants stay basic',async()=>{
 let sent;const {AdminAccountPackages,PersonalAccountPackages}=await components({issuePrivacyAccountPackage:async(id,body)=>{sent=body;}},{'admin-personal-documents':{items:[]},'admin-account-packages':{items:[],events:[]},'privacy-account-packages':[{id:8,expires_at:'2099-01-01',documents:[]}]});let r;
 await act(async()=>{r=create(React.createElement(AdminAccountPackages,{request,refresh:async()=>{}}));});
 assert.equal(r.root.findByProps({name:'transactions'}).props.checked,false);
 await act(async()=>r.root.findAllByProps({type:'checkbox'}).at(-1).props.onChange({target:{checked:true}}));
 await act(async()=>r.root.findByProps({name:'transactions'}).props.onChange({target:{checked:true}}));
 assert.equal(r.root.findByProps({type:'submit'}).props.disabled,true);
 await act(async()=>r.root.findAllByProps({type:'checkbox'}).at(-1).props.onChange({target:{checked:true}}));
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(JSON.stringify(sent.sections),'["transactions"]');
 assert.equal(r.root.findByProps({name:'transactions'}).props.checked,false);
 await act(async()=>r.unmount());
 await act(async()=>{r=create(React.createElement(PersonalAccountPackages,{request}));});
 const scope=r.root.findAllByType('p').find(p=>p.children[0]==='포함 범위: ');
 assert.equal(scope.children.join(''),'포함 범위: 기본정보·요청 처리이력');
 await act(async()=>r.unmount());
});
test('download failures clear password and show retryable error without claiming completion',async()=>{
 const {PersonalAccountPackages}=await components({privacyPackageFile:async()=>{throw Error('scope changed');}}, {'privacy-account-packages':[{id:8,expires_at:'2099-01-01',documents:[document]}]});let r;
 await act(async()=>{r=create(React.createElement(PersonalAccountPackages,{request}));});
 await act(async()=>r.root.findByType('input').props.onChange({target:{value:'temporary'}}));
 await act(async()=>r.root.findAllByType('button')[0].props.onClick());
 assert.equal(r.root.findByType('input').props.value,'');assert.equal(r.root.findByProps({role:'alert'}).children.join(''),'scope changed');assert.equal(r.root.findAllByProps({role:'status'}).length,0);
 await act(async()=>r.unmount());
});
test('cancelled requests keep inventory but never offer account/document download controls',async()=>{
 const {PersonalAccountPackages}=await components({}, {'privacy-account-packages':[{id:8,expires_at:'2099-01-01',documents:[document]}]});let r;
 await act(async()=>{r=create(React.createElement(PersonalAccountPackages,{request:{...request,status:'cancelled'}}));});
 assert.equal(r.root.findAllByType('button').length,0);assert.equal(r.root.findAllByType('input').length,0);
 assert.match(JSON.stringify(r.toJSON()),/personal.pdf/);await act(async()=>r.unmount());
});
test('collection/use/provision facts need a past period of at most 366 Korean days; it is sent with the section and shown in the scope',async()=>{
 let sent;const {AdminAccountPackages,PersonalAccountPackages,factsPeriod}=await components({issuePrivacyAccountPackage:async(id,body)=>{sent=body;}},{'admin-personal-documents':{items:[]},'admin-account-packages':{items:[],events:[]},'privacy-account-packages':[{id:9,expires_at:'2099-01-01',documents:[],sections:['transactions','location_facts'],facts_from:'2026-09-30T15:00:00Z',facts_until:'2026-10-31T15:00:00Z'},{id:8,expires_at:'2099-01-01',documents:[],sections:['location_facts'],facts_from:'2026-10-31T15:00:00Z',facts_until:'2026-11-06T03:10:00Z'}]});let r;
 await act(async()=>{r=create(React.createElement(AdminAccountPackages,{request,refresh:async()=>{}}));});
 const submit=()=>r.root.findByProps({type:'submit'}),confirm=()=>r.root.findAllByProps({type:'checkbox'}).at(-1),day=name=>r.root.findByProps({name});
 // No period fields, and nothing about a period in the request, until the section is chosen.
 assert.equal(r.root.findAllByProps({type:'date'}).length,0);
 await act(async()=>confirm().props.onChange({target:{checked:true}}));
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal('facts_from' in sent,false);assert.equal('facts_until' in sent,false);
 await act(async()=>day('location_facts').props.onChange({target:{checked:true}}));
 assert.equal(r.root.findAllByProps({type:'date'}).length,2);
 // The default is the last 180 days, which is a valid period.
 assert.equal(r.root.findAllByProps({role:'alert'}).length,0);
 await act(async()=>day('facts_from').props.onChange({target:{value:'2026-10-31'}}));
 await act(async()=>day('facts_until').props.onChange({target:{value:'2026-10-01'}}));
 await act(async()=>confirm().props.onChange({target:{checked:true}}));
 assert.equal(submit().props.disabled,true);assert.equal(r.root.findAllByProps({role:'alert'}).length,1);
 await act(async()=>day('facts_from').props.onChange({target:{value:'2026-10-01'}}));
 await act(async()=>day('facts_until').props.onChange({target:{value:'2026-10-31'}}));
 // Changing the period clears the attestation.
 assert.equal(submit().props.disabled,true);assert.equal(r.root.findAllByProps({role:'alert'}).length,0);
 await act(async()=>confirm().props.onChange({target:{checked:true}}));
 assert.equal(submit().props.disabled,false);
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(JSON.stringify(sent.sections),'["location_facts"]');
 // Korean calendar days: from the start of the first day to the end of the last one.
 assert.equal(sent.facts_from,'2026-09-30T15:00:00.000Z');assert.equal(sent.facts_until,'2026-10-31T15:00:00.000Z');
 await act(async()=>r.unmount());
 assert.equal(factsPeriod('2025-10-31','2026-10-31').facts_until,'2026-10-31T15:00:00.000Z');
 for(const [from,until] of [['2025-10-30','2026-10-31'],['2026-10-02','2026-10-01'],['2999-01-01','2999-01-02'],['','2026-10-01'],['2026-10-01','10/31/2026'],['2026-02-30x','2026-03-01']])assert.equal(factsPeriod(from,until),null,`${from}~${until}`);
 await act(async()=>{r=create(React.createElement(PersonalAccountPackages,{request}));});
 const scopes=r.root.findAllByType('p').filter(p=>p.children[0]==='포함 범위: ').map(p=>p.children.join(''));
 assert.equal(scopes[0],'포함 범위: 기본정보·요청 처리이력 / 결제·포인트·USIM 충전·구독 요약 / 위치정보 수집·이용·제공사실 (좌표 제외) 2026-10-01~2026-10-31');
 // Issued in the middle of the last day: that day is still the last day shown.
 assert.equal(scopes[1],'포함 범위: 기본정보·요청 처리이력 / 위치정보 수집·이용·제공사실 (좌표 제외) 2026-11-01~2026-11-06');
 await act(async()=>r.unmount());
});
