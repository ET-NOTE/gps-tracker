import {fileSaveMessage} from '../src/lib/fileDownload.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
async function components(api={},queries={},save=async()=>({status:'saved'})){
 const context=vm.createContext({console,FileReader:class {readAsDataURL(){this.result='data:application/pdf;base64,cGRm';this.onload();}}});
 const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
 const source=await readFile(new URL('../src/components/PrivacyCompanyTask.jsx',import.meta.url),'utf8');
 const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
 await m.link(name=>{
  if(name==='./CompanyTaskQueue')return moduleOf({useCompanyTaskQueue:()=>null,CompanyTaskTools:()=>null});
  if(name==='react')return moduleOf(React);if(name==='react/jsx-runtime')return moduleOf(jsx);
  if(name==='../api')return moduleOf({api});if(name==='../lib/fileDownload')return moduleOf({fileSaveMessage,saveBlob:save});
  if(name==='@tanstack/react-query')return moduleOf({useQuery:({queryKey})=>({data:queries[queryKey[0]],refetch:async()=>{}})});
  throw Error(name);
 });await m.evaluate();return m.namespace;
}
const row={id:3,revision:4,identity:'confirmed',staff_id:8,company_owner_id:9,status:'awaiting_company'};
const request={revision:7,status:'in_review'};
test('company publication requires disclosure confirmation, resets on changes and sends both revisions',async()=>{
 let sent;const {AdminCompanyTasks}=await components({publishCompanyTask:async(id,b)=>{sent={id,...b};}},{'admin-company-tasks':{items:[],events:[]}});let r;
 await act(async()=>{r=create(React.createElement(AdminCompanyTasks,{row,request,refresh:async()=>{}}));});
 assert.equal(r.root.findByProps({type:'submit'}).props.disabled,true);
 await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
 await act(async()=>r.root.findByType('textarea').props.onChange({target:{value:'Only confirmed scope'}}));
 assert.equal(r.root.findByProps({type:'checkbox'}).props.checked,false);
 await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(sent.review_revision,4);assert.equal(sent.request_revision,7);assert.equal(sent.confirmed,true);
 await act(async()=>r.unmount());
});
test('decision requires latest downloaded proof and renewed attestation after feedback changes',async()=>{
 let sent;const {CompanyTaskDecision}=await components({companyProof:async()=>({}),decideCompanyTask:async(id,b)=>{sent=b;}});let r;
 const task={id:10,revision:5,status:'submitted',expires_at:'2099-01-01'};
 const proof=id=>({id,sha256:`hash${id}`,mime:'application/pdf',size:50,filename:'evidence.pdf',created_at:'2026-11-05',executed_at:'2026-11-04',outcome:'provided'});
 await act(async()=>{r=create(React.createElement(CompanyTaskDecision,{item:{task,submissions:[proof(20),proof(19)]},row,request,refresh:async()=>{}}));});
 const check=()=>r.root.findByProps({type:'checkbox'});
 assert.equal(check().props.disabled,true);
 const buttons=()=>r.root.findAllByType('button').filter(x=>x.children.includes('증빙 내려받기'));
 await act(async()=>buttons()[1].props.onClick());assert.equal(check().props.disabled,true);
 await act(async()=>buttons()[0].props.onClick());assert.equal(check().props.disabled,false);
 await act(async()=>check().props.onChange({target:{checked:true}}));
 await act(async()=>r.root.findAllByType('textarea')[0].props.onChange({target:{value:'Verified against receipt'}}));
 assert.equal(check().props.checked,false);
 await act(async()=>r.root.findAllByType('textarea')[1].props.onChange({target:{value:'Scoped result'}}));
 await act(async()=>check().props.onChange({target:{checked:true}}));
 await act(async()=>r.root.findAllByType('button').find(x=>x.children.includes('검토 결과 대장에 반영')).props.onClick());
 assert.equal(sent.submission_id,20);assert.equal(sent.sha256,'hash20');assert.equal(sent.revision,5);assert.equal(sent.accept,true);
 await act(async()=>r.unmount());
});
test('submission requires explicit file confirmation and shows server failure without success refresh',async()=>{
 let sent,refreshed=false;const {CompanySubmissionForm}=await components({submitCompanyTask:async(id,b)=>{sent=b;throw Error('기한 만료');}});let r;
 await act(async()=>{r=create(React.createElement(CompanySubmissionForm,{task:{id:8,revision:3,kind:'rectification'},refresh:async()=>{refreshed=true;}}));});
 const file=r.root.findByProps({type:'file'});
 await act(async()=>file.props.onChange({target:{files:[{name:'evidence.pdf',type:'application/pdf',size:20}]}}));
 assert.equal(r.root.findByProps({type:'submit'}).props.disabled,true);
 await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(sent.outcome,'corrected');assert.equal(sent.revision,3);assert.equal(sent.file_base64,'cGRm');assert.equal(refreshed,false);
 assert.match(JSON.stringify(r.toJSON()),/기한 만료/);assert.match(JSON.stringify(r.toJSON()),/제출만으로 요청이 완료되지 않습니다/);
 await act(async()=>r.unmount());
});

for(const status of ['cancelled','saved','share_opened','browser_started','unknown'])test(`proof result ${status} never silently approves review`,async()=>{
 const {CompanyTaskDecision}=await components({companyProof:async()=>({})},{},async()=>({status}));let r;
 const props={item:{task:{id:10,revision:5,status:'submitted',expires_at:'2099-01-01'},submissions:[{id:20,sha256:'hash20',mime:'application/pdf',size:10,filename:'proof.pdf'}]},row,request,refresh:async()=>{}};
 await act(async()=>{r=create(React.createElement(CompanyTaskDecision,props));});
 await act(async()=>r.root.findAllByType('button').find(b=>b.children.includes('증빙 내려받기')).props.onClick());
 assert.equal(r.root.findByProps({type:'checkbox'}).props.disabled,!['saved','share_opened','browser_started'].includes(status));
 assert.equal(r.root.findByProps({type:'checkbox'}).props.checked,false);
 assert(r.root.findAllByType('button').find(b=>b.children.includes('검토 결과 대장에 반영')).props.disabled);
 assert.match(JSON.stringify(r.toJSON()),new RegExp(fileSaveMessage({status}).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')));
 await act(async()=>r.unmount());
});
test('new cancelled or failed download clears earlier proof permission; pending file work blocks review',async()=>{
 let resolve,mode='saved';const save=()=>mode==='pending'?new Promise(r=>{resolve=r;}):mode==='fail'?Promise.reject(Error('저장 실패')):Promise.resolve({status:mode});
 const {CompanyTaskDecision}=await components({companyProof:async()=>({})},{},save);let r;
 const props={item:{task:{id:10,revision:5,status:'submitted',expires_at:'2099-01-01'},submissions:[{id:20,sha256:'hash20',mime:'application/pdf',size:10,filename:'proof.pdf'}]},row,request,refresh:async()=>{}};
 await act(async()=>{r=create(React.createElement(CompanyTaskDecision,props));});
 const download=()=>r.root.findAllByType('button').find(b=>b.children.includes('증빙 내려받기'));
 const check=()=>r.root.findByProps({type:'checkbox'});
 await act(async()=>download().props.onClick());assert.equal(check().props.disabled,false);
 await act(async()=>check().props.onChange({target:{checked:true}}));
 mode='pending';let operation;await act(async()=>{operation=download().props.onClick();});
 assert.equal(check().props.disabled,true);assert.equal(check().props.checked,false);
 assert(r.root.findAllByType('fieldset').every(f=>f.props.disabled));
 await act(async()=>{resolve({status:'cancelled'});await operation;});assert.equal(check().props.disabled,true);
 mode='fail';await act(async()=>download().props.onClick());assert.match(JSON.stringify(r.toJSON()),/저장 실패/);assert.equal(check().props.disabled,true);
 await act(async()=>r.unmount());
});
test('replacing a submission invalidates an in-flight save result',async()=>{
 let resolve;const {CompanyTaskDecision}=await components({companyProof:async()=>({})},{},()=>new Promise(r=>{resolve=r;}));let r;
 const task={id:10,revision:5,status:'submitted',expires_at:'2099-01-01'},proof={id:20,sha256:'hash20',mime:'application/pdf',size:10,filename:'proof.pdf'};
 const props={item:{task,submissions:[proof]},row,request,refresh:async()=>{}};
 await act(async()=>{r=create(React.createElement(CompanyTaskDecision,props));});let operation;
 await act(async()=>{operation=r.root.findAllByType('button').find(b=>b.children.includes('증빙 내려받기')).props.onClick();});
 await act(async()=>r.update(React.createElement(CompanyTaskDecision,{...props,item:{task:{...task,revision:6},submissions:[{...proof,id:21,sha256:'hash21'}]}})));
 await act(async()=>{resolve({status:'saved'});await operation;});
 assert.equal(r.root.findByProps({type:'checkbox'}).props.disabled,true);assert.equal(r.root.findByProps({type:'checkbox'}).props.checked,false);
 await act(async()=>r.unmount());
});
