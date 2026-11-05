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
 const source=await readFile(new URL('../src/components/PrivacyCompanyReview.jsx',import.meta.url),'utf8');
 const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
 const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
 await m.link(name=>{
  if(name==='./PrivacyCompanyTask')return moduleOf({AdminCompanyTasks:({children})=>children,CompanyTaskInbox:()=>null});
  if(name==='react')return moduleOf(React);if(name==='react/jsx-runtime')return moduleOf(jsx);
  if(name==='../api')return moduleOf({api});
  if(name==='@tanstack/react-query')return moduleOf({useQuery:({queryKey})=>({data:queries[queryKey[0]],refetch:async()=>{}})});
  throw Error(name);
 });await m.evaluate();return m.namespace;
}
const row={id:2,revision:3,identity:'pending',status:'identity_pending',identity_evidence:'',evidence_reference:'',internal_reason:'',public_message:'확인 중',due_at:'2099-01-01',category:'trips',from_at:'2026-11-01',until_at:'2026-11-02'};
test('company completion requires explicit attestation; changing evidence resets it and sends both revisions',async()=>{
 let sent;const {CompanyReviewEditor}=await components({updateCompanyReview:async(id,b)=>{sent={id,...b};}});let r;
 await act(async()=>{r=create(React.createElement(CompanyReviewEditor,{row,request:{id:7,revision:5,kind:'access'},refresh:async()=>{}}));});
 const set=async(index,value)=>act(async()=>r.root.findAllByType('select')[index].props.onChange({target:{value}}));
 await set(0,'confirmed');await set(1,'verified');assert.equal(r.root.findByProps({type:'submit'}).props.disabled,true);
 await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
 assert.equal(r.root.findByProps({type:'submit'}).props.disabled,false);
 await act(async()=>r.root.findAllByType('textarea')[0].props.onChange({target:{value:'내부 검토 근거'}}));
 assert.equal(r.root.findByProps({type:'checkbox'}).props.checked,false);
 await act(async()=>r.root.findByProps({type:'checkbox'}).props.onChange({target:{checked:true}}));
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(sent.request_revision,5);assert.equal(sent.revision,3);assert.equal(sent.outcome,'provided');assert.equal(sent.confirmed,true);
 await act(async()=>r.unmount());
});
test('public summary cannot render internal evidence or counts; result does not claim total deletion',async()=>{
 const {CompanyReviewSummary}=await components();let r;
 await act(async()=>{r=create(React.createElement(CompanyReviewSummary,{items:[{...row,message:'회사에 본인 범위를 확인 중입니다.',identity_evidence:'SECRET',company_owner_id:'SECRET',inventory:{trips:{count:99999}},internal_reason:'SECRET'}]}));});
 const rendered=JSON.stringify(r.toJSON());assert.doesNotMatch(rendered,/SECRET|99999/);assert.match(rendered,/전체 자료 삭제 완료를 뜻하지 않습니다/);assert.match(rendered,/검토 기한/);
 await act(async()=>r.unmount());
});
test('scope dates use Korean inclusive days; historical links stay candidates, not identity proof',async()=>{
 let sent;const {AdminCompanyReviews}=await components({createCompanyReview:async(id,b)=>{sent={id,...b};}},{'admin-privacy-company':{items:[],events:[]},'admin-privacy-company-candidates':{items:[{owner_id:20,staff_id:30,company_name:'회사',currently_linked:false}]}});let r;
 await act(async()=>{r=create(React.createElement(AdminCompanyReviews,{request:{id:7,revision:4,status:'in_review',due_at:'2099-01-01'},refresh:async()=>{}}));});
 assert.match(JSON.stringify(r.toJSON()),/연결 해제 이력/);assert.match(JSON.stringify(r.toJSON()),/본인 확인의 단서/);
 await act(async()=>{
  r.root.findAllByType('select')[0].props.onChange({target:{value:'20:30'}});
  r.root.findAllByProps({type:'date'})[0].props.onChange({target:{value:'2026-11-01'}});
  r.root.findAllByProps({type:'date'})[1].props.onChange({target:{value:'2026-11-02'}});
 });
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(sent.from_at,'2026-10-31T15:00:00.000Z');assert.equal(sent.until_at,'2026-11-02T15:00:00.000Z');assert.equal(sent.company_owner_id,20);assert.equal(sent.staff_id,30);assert.equal(sent.revision,4);assert.equal(sent.identity,undefined);
 await act(async()=>r.unmount());
});
test('server revision conflict stays visible without reporting success',async()=>{
 let refreshed=false;const {CompanyReviewEditor}=await components({updateCompanyReview:async()=>{throw Error('검토 내용이 바뀌었습니다.');}});let r;
 await act(async()=>{r=create(React.createElement(CompanyReviewEditor,{row,request:{revision:8,kind:'erasure'},refresh:async()=>{refreshed=true;}}));});
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.match(JSON.stringify(r.root.findByProps({role:'alert'}).toJSON?.()||r.toJSON()),/검토 내용이 바뀌었습니다/);assert.equal(refreshed,false);
 await act(async()=>r.unmount());
});
