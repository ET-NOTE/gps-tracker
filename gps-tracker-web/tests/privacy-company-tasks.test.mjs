import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
async function components(api={},queries={}){
 const context=vm.createContext({console,FileReader:class {readAsDataURL(){this.result='data:application/pdf;base64,cGRm';this.onload();}}});
 const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
 const source=await readFile(new URL('../src/components/PrivacyCompanyTask.jsx',import.meta.url),'utf8');
 const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
 await m.link(name=>{
  if(name==='react')return moduleOf(React);if(name==='react/jsx-runtime')return moduleOf(jsx);
  if(name==='../api')return moduleOf({api});if(name==='../lib/fileDownload')return moduleOf({saveBlob:async()=>{}});
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
