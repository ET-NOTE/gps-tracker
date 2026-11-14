import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
async function components(api={},queries={}) {
  const context=vm.createContext({console,window:{addEventListener(){},removeEventListener(){}}});
  const source=await readFile(new URL('../src/components/PrivacyDelivery.jsx',import.meta.url),'utf8');
  const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [k,v] of Object.entries(exports))this.setExport(k,v);},{context});
  const code=(await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code;
  const m=new vm.SourceTextModule(code,{context});
  await m.link(name=>{
    if(name==='./PrivacyCompanyReview')return moduleOf({CompanyReviewSummary:()=>null,PersonalCompanyReviews:()=>null,AdminCompanyReviews:()=>null});
    if(name==='react')return moduleOf(React);if(name==='react/jsx-runtime')return moduleOf(jsx);
    if(name==='react-router-dom')return moduleOf({Link:({children})=>React.createElement('a',{},children)});
    if(name==='../api')return moduleOf({api});
    if(name==='../lib/fileDownload')return moduleOf({saveBlob:async()=>{}});
    if(name==='@tanstack/react-query')return moduleOf({useQuery:({queryKey})=>({data:queries[queryKey[0]],refetch:async()=>{}})});
    if(name.endsWith('.css'))return moduleOf({});throw Error(name);
  });await m.evaluate();return m.namespace;
}
test('result-only form clears password after response and retains closure warning',async()=>{
  let sent;const {default:Page}=await components({privacyResult:async body=>{sent={...body};return{id:4,status:'in_review',account_restricted:true,scope:'내 요청',created_at:'2026-11-01',history:[]};}});
  let r;await act(async()=>{r=create(React.createElement(Page));});
  await act(async()=>{for(const [type,value] of [['email','test@example.invalid'],['password','fixture'],['number','4']])r.root.findByProps({type}).props.onChange({target:{value}});});
  await act(async()=>{await r.root.findByType('form').props.onSubmit({preventDefault(){}});});
  assert.equal(sent.request_id,4);assert.equal(sent.password,'fixture');assert.equal(r.root.findByProps({type:'password'}).props.value,'');
  assert.match(JSON.stringify(r.toJSON()),/일반 로그인이나 위치 조회 권한은 복구되지 않습니다/);
  assert.match(JSON.stringify(r.toJSON()),/계정 이용 종료 · 자료 처리는/);
  await act(async()=>r.unmount());
});
test('expired and revoked grants have no download button; active requires password and clears it on failure',async()=>{
  const past='2020-01-01',future='2099-01-01';const grants=[{id:1,expires_at:past},{id:2,expires_at:future,revoked_at:past},{id:3,expires_at:future}].map(x=>({...x,device_ids:[99],from_at:past,until_at:past}));
  let sent;const {PersonalDeliveries}=await components({downloadPrivacyDelivery:async(id,password)=>{sent=[id,password];throw Error('회수됐습니다');}},{'privacy-deliveries':grants});
  let r;await act(async()=>{r=create(React.createElement(PersonalDeliveries,{request:{id:1,status:'in_review',revision:1}}));});
  assert.equal(r.root.findAllByType('button').length,1);assert.equal(r.root.findByType('button').props.disabled,true);
  await act(async()=>r.root.findByProps({type:'password'}).props.onChange({target:{value:'fixture'}}));
  await act(async()=>r.root.findByType('button').props.onClick());
  assert.deepEqual(sent,[3,'fixture']);assert.equal(r.root.findByProps({type:'password'}).props.value,'');assert.match(JSON.stringify(r.toJSON()),/회수됐습니다/);
  await act(async()=>r.unmount());
});
test('administrator must select device and confirm scope; dates include Korean end day',async()=>{
  let sent;const {AdminDeliveries}=await components({issuePrivacyDelivery:async(id,body)=>{sent={id,...body};}},{'admin-privacy-deliveries':{items:[],events:[]},'admin-privacy-delivery-options':{items:[{id:42,name:'테스트'}]}});
  let r;await act(async()=>{r=create(React.createElement(AdminDeliveries,{request:{id:7,status:'in_review',revision:2,due_at:'2099-01-01'},refresh:async()=>{}}));});
  assert.equal(r.root.findByProps({type:'submit'}).props.disabled,true);
  await act(async()=>{
    r.root.findAllByProps({type:'date'})[0].props.onChange({target:{value:'2026-11-01'}});
    r.root.findAllByProps({type:'date'})[1].props.onChange({target:{value:'2026-11-02'}});
    for(const input of r.root.findAllByProps({type:'checkbox'}))input.props.onChange({target:{checked:true}});
  });
  await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
  assert.equal(sent.from_at,'2026-10-31T15:00:00.000Z');assert.equal(sent.until_at,'2026-11-02T15:00:00.000Z');assert.equal(sent.confirmed,true);assert.equal(sent.device_ids[0],42);
  await act(async()=>r.unmount());
});
