import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {QueryClient} from '@tanstack/react-query';
import {act,create} from 'react-test-renderer';
import {transform} from 'esbuild';
import * as rentalOffice from '../src/lib/rentalOffice.js';

async function fixture() {
  const qc=new QueryClient({defaultOptions:{queries:{gcTime:Infinity}}});
  const api={},messages=[];
  const source=await readFile(new URL('../src/components/business/RentalOfficeDelete.jsx',import.meta.url),'utf8');
  const code=(await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code;
  const context=vm.createContext({console});
  const catalogKey=()=>['owner','catalog'],bookKey=()=>['owner','book'];
  const modules={
    react:React,'react/jsx-runtime':jsx,'@tanstack/react-query':{useQueryClient:()=>qc},
    '../../api':{api},'../Icon':{default:()=>null},'../../lib/rentalOffice':rentalOffice,
    '../ui':{Button:'button',toast:{success:msg=>messages.push(msg),error:msg=>messages.push(msg)}},
    './RentalOfficeKit':{FormModal:'confirmation'},'./rentalOfficeKeys':{officeBookKey:bookKey,officeCatalogKey:catalogKey}
  };
  const mod=new vm.SourceTextModule(code,{context});
  await mod.link(name=>new vm.SyntheticModule(Object.keys(modules[name]),function(){
    for(const [key,value] of Object.entries(modules[name]))this.setExport(key,value);
  },{context}));
  await mod.evaluate();
  return {Delete:mod.namespace.default,qc,api,messages};
}

test('template deletion blocks a linked contract and submits only the revision the user saw',async()=>{
  const {Delete,api}=await fixture(),row={id:9,revision:2,name:'표준',in_use:true};
  let r,calls=0;
  const page=record=>React.createElement(Delete,{kind:'templates',row:record,onDeleted:()=>assert.fail('linked or stale template deleted')});
  await act(async()=>{r=create(page(row));});
  try {
    await act(async()=>r.root.findByType('button').props.onClick());
    assert.match(r.root.findByProps({role:'alert'}).children[0],/계약에 연결/);
    assert.equal(r.root.findAllByType('confirmation').length,0);
    await act(async()=>r.update(page({...row,in_use:false})));
    await act(async()=>r.root.findByType('button').props.onClick());
    await act(async()=>r.root.findByType('confirmation').props.onClose());
    assert.equal(r.root.findAllByType('confirmation').length,0);
    await act(async()=>r.root.findByType('button').props.onClick());
    await act(async()=>r.update(page({...row,revision:3,in_use:false})));
    api.rentalOffice=async(method,route,body)=>{
      calls++;assert.equal(method,'DELETE');assert.equal(route,'/templates/9');assert.equal(body.revision,2);
      throw Object.assign(Error('변경된 기록입니다.'),{status:409});
    };
    await act(async()=>r.root.findByType('confirmation').props.save());
    assert.equal(calls,1);assert.equal(r.root.findAllByType('confirmation').length,0);
    assert.match(r.root.findByProps({role:'alert'}).children[0],/변경된 기록/);
  } finally {await act(async()=>r.unmount());}
});

test('deleting a cost updates all cached periods for the current account only',async()=>{
  const {Delete,api,qc,messages}=await fixture(),row={id:4,revision:1,category:'wash',amount_krw:15000};
  const keys=[['owner','book','november'],['owner','book','year'],['another','book','november']];
  for(const key of keys)qc.setQueryData(key,{costs:[row,{id:5}],contracts:[],entries:[]});
  let r,closed=false;
  api.rentalOffice=async(method,route,body)=>{assert.equal(method,'DELETE');assert.equal(route,'/costs/4');assert.equal(body.revision,1);};
  await act(async()=>{r=create(React.createElement(Delete,{kind:'costs',row,onDeleted:()=>{closed=true;}}));});
  try {
    await act(async()=>r.root.findByType('button').props.onClick());
    await act(async()=>r.root.findByType('confirmation').props.save());
    assert.equal(closed,true);assert.deepEqual(messages,['운영비를 삭제했습니다.']);
    assert.deepEqual(keys.map(key=>qc.getQueryData(key).costs.map(c=>c.id)),[[5],[5],[4,5]]);
  } finally {await act(async()=>r.unmount());qc.clear();}
});
