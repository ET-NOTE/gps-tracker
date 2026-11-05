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
 await act(async()=>r.root.findAllByProps({type:'checkbox'})[1].props.onChange({target:{checked:true}}));
 await act(async()=>r.root.findByType('form').props.onSubmit({preventDefault(){}}));
 assert.equal(sent.revision,7);assert.equal(sent.documents[0].sha256,'a'.repeat(64));assert.equal(sent.documents[0].id,10);assert.equal(sent.confirmed,true);
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
