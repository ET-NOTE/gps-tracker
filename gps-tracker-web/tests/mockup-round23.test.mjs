import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {act,create} from 'react-test-renderer';
import {transform} from 'esbuild';
import {valueText,dotDateTime,dotDay,oneDecimal,splitUnit} from '../src/lib/mockupFormat.js';

const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const flat=value=>value.replace(/\s+/g,' ');

async function loadKit(){
  const context=vm.createContext({console});
  const code=(await transform(await readFile(new URL('../src/components/business/RentalOfficeKit.jsx',import.meta.url),'utf8'),{loader:'jsx',jsx:'automatic',format:'esm'})).code;
  const modules={react:React,'react/jsx-runtime':jsx,'../ui':{Button:()=>null,Modal:()=>null},'../Icon':{default:()=>null},
    '../../useCorporatePhone':{default:()=>false},'../../lib/mockupHidden':{hideOutsideMockup:true}};
  const mod=new vm.SourceTextModule(code,{context});
  await mod.link(name=>new vm.SyntheticModule(Object.keys(modules[name]),function(){for(const [k,v] of Object.entries(modules[name]))this.setExport(k,v);},{context}));
  await mod.evaluate();
  return mod.namespace;
}

test('bar values, dotted dates and one-decimal numbers follow the design text',()=>{
  assert.equal(valueText(20.43,'%'),'20.4 %');
  assert.equal(valueText(1,'건'),'1 건');
  assert.equal(valueText(740000,'원'),'740,000 원');
  assert.equal(dotDateTime('2026-11-20T01:42:00Z'),'2026.11.20 10:42');
  assert.equal(dotDay('2026-11-20'),'2026.11.20');
  assert.equal(dotDateTime(null),'');
  assert.equal(oneDecimal(0),'0.0');assert.equal(oneDecimal(95),'95.0');
  assert.deepEqual(splitUnit('1,905,000원'),['1,905,000','원']);
});

test('summary cards keep money attached and counts small; statistics pages make money small too',async()=>{
  const {Metrics}=await loadKit();
  let r;await act(async()=>{r=create(React.createElement(Metrics,{items:[['조회 운영비','585,000원','wallet'],['지출 기록','9건']]}));});
  const values=r.root.findAllByType('dd');
  assert.equal(values[0].findAllByType('small').length,0);assert.equal(text(values[0].children),'585,000원');
  assert.equal(text(values[1].findByType('small').children),'건');
  await act(async()=>{r.update(React.createElement(Metrics,{smallMoney:true,items:[['운영비','585,000원']]}));});
  assert.equal(text(r.root.findByType('dd').findByType('small').children),'원');
});

test('an empty table shows the empty-state block without a header row',async()=>{
  const {Table}=await loadKit();
  let r;await act(async()=>{r=create(React.createElement(Table,{columns:[['차종',x=>x]],rows:[],empty:'조회된 요금표 항목이 없습니다.'}));});
  assert.equal(r.root.findAllByType('thead').length,0);
  const block=r.root.findByProps({className:'mockup-empty'});
  assert.match(text(block.children),/조회된 요금표 항목이 없습니다\.조회 조건을 변경하거나 새 항목을 등록해 주세요\./);
});

test('phone dashboard vehicles give the name the free width and hide the extra columns',async()=>{
  const css=flat(await readFile(new URL('../src/components/business/fleet-mockup-sync.css',import.meta.url),'utf8'));
  assert.match(css,/\.fleet-dashboard-vehicles button \{display:grid!important; grid-template-columns:minmax\(0,1fr\) auto auto;/);
  assert.match(css,/\.fleet-dashboard-vehicles button>:is\(\.fleet-dashboard-manager,\.fleet-dashboard-km\) \{display:none!important\}/);
});
