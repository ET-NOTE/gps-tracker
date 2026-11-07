import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

async function components(api={}) {
  const context=vm.createContext({console,crypto:webcrypto});
  const source=await readFile(new URL('../src/components/PrivacyRequests.jsx',import.meta.url),'utf8');
  const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
  const code=(await transform(source+'\nexport {ReviewForm};',{loader:'jsx',jsx:'automatic',format:'esm'})).code;
  const m=new vm.SourceTextModule(code,{context});
  await m.link(name=>{
    if(name==='./SubjectProvision')return moduleOf({SubjectMappings:()=>null,ProvisionNotices:()=>null});
    if(name==='./PrivacyImages')return moduleOf({PersonalImages:()=>null,AdminImages:()=>null});
    if(name==='./PrivacyRedacted')return moduleOf({PersonalRedacted:()=>null,AdminRedacted:()=>null});
    if(name==='./PrivacyAccountPackage')return moduleOf({PersonalAccountPackages:()=>null,AdminAccountPackages:()=>null});
    if(name==='./PrivacyCompanyReview')return moduleOf({CompanyReviewSummary:()=>null,PersonalCompanyReviews:()=>null,AdminCompanyReviews:()=>null});
    if(name==='./PrivacyCompanyTask')return moduleOf({CompanyTaskInbox:()=>null});
    if(name==='react')return moduleOf(React);
    if(name==='react/jsx-runtime')return moduleOf(jsx);
    if(name==='../api')return moduleOf({api});
    if(name==='@tanstack/react-query')return moduleOf({useQuery:()=>({data:[],isPending:false}),useQueryClient:()=>({invalidateQueries:async()=>{}})});
    if(name.endsWith('.css'))return moduleOf({});
    if((name==='./CollectionControl'||name==='./ProcessingControl'))return moduleOf({default:()=>null});
    if(name==='./PrivacyDelivery')return moduleOf({PersonalDeliveries:()=>null,AdminDeliveries:()=>null});
    throw Error(name);
  });await m.evaluate();return m.namespace;
}
test('request retries preserve idempotency key and never describe acceptance as deletion',async()=>{
  const calls=[];
  const {default:Panel}=await components({createPrivacyRequest:async body=>{calls.push({...body});if(calls.length===1)throw Error('network retry');return{id:17};}});
  let r;await act(async()=>{r=create(React.createElement(Panel));});
  await act(async()=>{r.root.findByType('select').props.onChange({target:{value:'account_closure'}});r.root.findByType('textarea').props.onChange({target:{value:'개인 계정 탈퇴'}});r.root.findByType('input').props.onChange({target:{value:'example-only'}});});
  await act(async()=>{await r.root.findByType('form').props.onSubmit({preventDefault(){}});});
  assert.equal(r.root.findByProps({role:'alert'}).children.join(''),'network retry');
  await act(async()=>{await r.root.findByType('form').props.onSubmit({preventDefault(){}});});
  assert.equal(calls.length,2);assert.equal(calls[0].request_key,calls[1].request_key);
  assert.equal(calls[1].kind,'account_closure');assert.equal(calls[1].scope,'개인 계정 탈퇴');
  assert.match(r.root.findByProps({role:'status'}).children.join(''),/접수했습니다/);
  assert.equal(r.root.findByType('input').props.value,'');
  assert.match(JSON.stringify(r.toJSON()),/접수만으로 위치 수집이 중지되거나 계정·기록이 삭제되지는 않습니다/);
  await act(async()=>r.unmount());
});
test('administrator cannot select completion for erasure or closure; normal access can complete',async()=>{
  const {ReviewForm}=await components();
  for(const kind of ['erasure','account_closure','access']){
    let r;await act(async()=>{r=create(React.createElement(ReviewForm,{detail:{request:{id:1,kind,status:'received',revision:1},events:[],evidence_reference:''},refresh:async()=>{}}));});
    const options=r.root.findAllByType('option').map(n=>n.props.value);
    assert.equal(options.includes('fulfilled'),kind==='access');
    const deadline=r.root.findByProps({type:'datetime-local'});assert.equal(deadline.props.required,true);
    await act(async()=>r.unmount());
  }
});
test('closed requests keep their event history without an edit form',async()=>{
  const {ReviewForm}=await components();
  let r;await act(async()=>{r=create(React.createElement(ReviewForm,{detail:{request:{id:2,kind:'access',status:'fulfilled',revision:3},events:[{revision:3,status:'fulfilled',message:'전달 확인',created_at:'2026-11-05T00:00:00Z'}],evidence_reference:'case-2'}}));});
  assert.equal(r.root.findAllByType('form').length,0);assert.match(JSON.stringify(r.toJSON()),/전달 확인/);
  await act(async()=>r.unmount());
});
