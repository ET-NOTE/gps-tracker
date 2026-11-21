import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as query from '@tanstack/react-query';
import {act,create} from 'react-test-renderer';
import {transform} from 'esbuild';
import {kstDateTime} from '../src/lib/businessExport.js';

const source=await readFile(new URL('../src/components/business/RentalCustomerHistory.jsx',import.meta.url),'utf8');
const {code}=await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'});
const label=node=>Array.isArray(node)?node.map(label).join(''):typeof node==='string'?node:node?.children?label(node.children):'';
async function settle(condition) {
  for(let tries=0;tries<50&&!condition();tries++)await act(async()=>new Promise(resolve=>setTimeout(resolve,5)));
  assert.ok(condition());
}
async function mount(api) {
  const context=vm.createContext({console});
  const module=new vm.SourceTextModule(code,{context});
  const tag=type=>({children,...props})=>React.createElement(type,props,children);
  const deps={
    react:React,'react/jsx-runtime':jsx,'@tanstack/react-query':query,'../../api':{api},'../../authSession':{authScope:()=> 'owner'},
    '../../lib/businessExport':{kstDateTime},'./RentalStageTable':{StageBadge:({contract})=>contract.status},'../ui':{Modal:tag('aside')},
    './BusinessWorkspace':{BusinessButton:tag('button'),BusinessError:({children,onRetry})=>React.createElement('p',{role:'alert'},children,React.createElement('button',{onClick:onRetry},'다시 시도'))},
    './RentalRecordDrawer':{default:({children,footer})=>React.createElement('aside',{role:'dialog'},children,footer)},
    './RentalContractDetails':{default:({contract})=>React.createElement('output',{},contract.note),ContractTerms:tag('section')},
    './RentalPhotos':{ContractPhotos:tag('section')},'./useBusinessData':{useBusinessClock:()=>Date.now()},
  };
  await module.link(spec=>new vm.SyntheticModule(Object.keys(deps[spec]),function(){for(const [key,value] of Object.entries(deps[spec]))this.setExport(key,value);},{context}));await module.evaluate();
  const client=new query.QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
  let root;
  await act(async()=>{root=create(React.createElement(query.QueryClientProvider,{client},React.createElement(module.namespace.default,{customerId:4})));});
  const button=text=>root.root.findAllByType('button').find(node=>label(node).includes(text));
  return {root,button,click:async text=>act(async()=>{await button(text).props.onClick();}),close:async()=>{await act(async()=>root.unmount());client.clear();}};
}
const record={id:11,starts_at:'2026-11-01T00:00:00Z',ends_at:'2026-11-01T12:00:00Z',status:'returned',role:'driver',driver_name:'김운전',renter_name:'박계약'};

test('customer history preserves the first page across retry and opens the full contract selected by ID',async()=>{
  let later=0,detail=0;const calls=[];
  const ui=await mount({
    rentalCustomerContracts:async(id,cursor)=>{assert.equal(id,4);calls.push(cursor);
      if(!cursor)return {total:2,items:[record],next_cursor:'next'};
      if(++later===1)throw Error('network');
      return {total:2,items:[{...record,id:10,role:'both'}],next_cursor:null};},
    getRentalContract:async id=>{assert.equal(id,11);if(++detail===1)throw Error('network');return {...record,note:'원장 원문'};},
  });
  try{
    await settle(()=>ui.button('더 보기'));
    assert.match(label(ui.button('R-11')),/실운전자 · 계약 고객 박계약/);
    await ui.click('더 보기');await settle(()=>ui.button('다시 시도'));
    assert.ok(ui.button('R-11'));await ui.click('다시 시도');await settle(()=>ui.button('R-10'));
    assert.deepEqual(calls,[null,'next','next']);assert.match(label(ui.button('R-10')),/계약 고객 · 실운전자/);
    await ui.click('R-11');await settle(()=>ui.button('다시 시도'));assert.equal(ui.root.root.findAllByType('output').length,0);
    await ui.click('다시 시도');await settle(()=>ui.root.root.findAllByType('output').length);assert.equal(label(ui.root.root.findByType('output')),'원장 원문');
    await ui.click('대여 이력으로');assert.ok(ui.button('R-10'));assert.equal(ui.root.root.findAllByProps({role:'dialog'}).length,0);
  }finally{await ui.close();}
});

test('denied next-page reads hide previously loaded customer history',async()=>{
  const ui=await mount({rentalCustomerContracts:async(id,cursor)=>{if(cursor)throw Object.assign(Error('unavailable'),{status:403});return {total:2,items:[record],next_cursor:'next'};}});
  try{await settle(()=>ui.button('더 보기'));await ui.click('더 보기');await settle(()=>ui.root.root.findAllByProps({role:'alert'}).length);
    assert.equal(ui.button('R-11'),undefined);assert.equal(ui.button('더 보기'),undefined);
  }finally{await ui.close();}
});
