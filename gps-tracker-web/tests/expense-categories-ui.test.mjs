import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

const categories=Object.freeze([
 {id:1,kind:'group',name:'차량유지비',active:true,parent_id:null},
 {id:2,kind:'fuel',name:'유류비',active:true,parent_id:1},
 {id:3,kind:'expense',name:'정비비',active:false,parent_id:1},
 {id:4,kind:'group',name:'여비교통비',active:false,parent_id:null},
 {id:5,kind:'expense',name:'숙박비',active:true,parent_id:4},
 {id:6,kind:'group',name:'기타',active:true,parent_id:null},
].map(Object.freeze));
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const button=(r,label)=>r.root.find(n=>n.type==='button'&&text(n.children)===label);
const group=(r,id)=>r.root.find(n=>n.type==='button'&&n.props['aria-pressed']!==undefined&&text(n.children).startsWith(categories.find(c=>c.id===id).name));
const tableRows=r=>r.root.findAllByType('tbody').flatMap(n=>n.findAllByType('tr'));

async function mount(t,options={}){
 const context=vm.createContext({console});
 const synthetic=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});
 const source=await readFile(new URL('../src/components/business/ExpenseCategorySettings.jsx',import.meta.url),'utf8');
 const code=(await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const mod=new vm.SourceTextModule(code,{context});
 const modules={'react':React,'react/jsx-runtime':jsx,'./BusinessWorkspace':{
  BusinessButton:({children,icon,...props})=>React.createElement('button',props,children),
  BusinessEmpty:({title})=>React.createElement('p',{},title),
 }};
 await mod.link(name=>synthetic(modules[name]||{}));await mod.evaluate();
 const edits=[];let props={categories,canManage:true,onEdit:item=>edits.push(item),...options},r;
 await act(async()=>{r=create(React.createElement(mod.namespace.default,props));});
 t.after(async()=>{await act(async()=>r.unmount());});
 return {r,edits,update:async patch=>{props={...props,...patch};await act(async()=>r.update(React.createElement(mod.namespace.default,props)));}};
}

test('expense categories show only the selected group and distinguish fuel and inactive children',async t=>{
 const {r}=await mount(t);
 assert.equal(group(r,1).props['aria-pressed'],true);
 assert.equal(tableRows(r).length,2);
 assert.match(text(tableRows(r)[0].children),/유류비.*승인 시 운행 주유비에 반영.*사용 중/);
 assert.match(text(tableRows(r)[1].children),/정비비.*일반 비용.*사용 중지/);
 assert.doesNotMatch(text(r.root.findByType('tbody').children),/숙박비/);
 assert.equal(text(group(r,1).findAllByType('span').at(-1).children),'2');
 await act(async()=>group(r,6).props.onClick());
 assert.equal(tableRows(r).length,0);
 assert.match(text(r.toJSON()),/등록된 세부 항목이 없습니다/);
});

test('inactive parent prevents child creation and makes active children effectively inactive',async t=>{
 const {r,edits}=await mount(t);
 await act(async()=>group(r,4).props.onClick());
 assert.equal(group(r,4).props['aria-pressed'],true);
 assert.equal(button(r,'세부 항목 추가').props.disabled,true);
 assert.match(text(tableRows(r)[0].children),/숙박비.*사용 중지/);
 assert.doesNotMatch(text(tableRows(r)[0].children),/사용 중수정/);
 await act(async()=>button(r,'대분류 수정').props.onClick());
 assert.equal(edits[0],categories[3]);
 await act(async()=>r.root.findByProps({'aria-label':'숙박비 수정'}).props.onClick());
 assert.equal(edits[1],categories[4]);
 assert.equal(categories[4].active,true,'effective status does not rewrite the saved child status');
});

test('read-only category browsing exposes no create or edit actions',async t=>{
 const {r,edits}=await mount(t,{canManage:false});
 assert.deepEqual(r.root.findAllByType('th').map(n=>text(n.children)),['항목명','종류','상태']);
 assert.equal(r.root.findAll(n=>n.type==='button'&&n.props['aria-pressed']===undefined).length,0);
 await act(async()=>group(r,4).props.onClick());
 assert.match(text(tableRows(r)[0].children),/숙박비.*사용 중지/);
 assert.equal(r.root.findAll(n=>n.type==='button'&&n.props['aria-label']?.endsWith('수정')).length,0);
 assert.deepEqual(edits,[]);
});

test('category actions preserve IDs, fuel kind and parent relationships without mutating source records',async t=>{
 const before=JSON.stringify(categories),{r,edits}=await mount(t);
 await act(async()=>button(r,'추가').props.onClick());
 assert.deepEqual({...edits[0]},{kind:'group',name:'',active:true,parent_id:null});
 await act(async()=>button(r,'세부 항목 추가').props.onClick());
 assert.deepEqual({...edits[1]},{kind:'expense',name:'',active:true,parent_id:1});
 await act(async()=>r.root.findByProps({'aria-label':'유류비 수정'}).props.onClick());
 assert.equal(edits[2],categories[1]);assert.equal(edits[2].kind,'fuel');
 await act(async()=>button(r,'대분류 수정').props.onClick());
 assert.equal(edits[3],categories[0]);
 assert.equal(JSON.stringify(categories),before);
});

test('category refresh keeps the selected group by ID and falls back safely when removed',async t=>{
 const {r,update}=await mount(t);
 await act(async()=>group(r,4).props.onClick());
 const renamed=categories.map(c=>c.id===4?{...c,name:'출장비',active:true}:c);
 await update({categories:renamed});
 assert.match(text(r.root.findByProps({'aria-label':'지출 세부 항목'}).findByType('h3').children),/출장비/);
 assert.equal(button(r,'세부 항목 추가').props.disabled,false);
 assert.match(text(tableRows(r)[0].children),/숙박비.*사용 중/);
 await update({categories:renamed.filter(c=>c.id!==4&&c.parent_id!==4)});
 assert.equal(group(r,1).props['aria-pressed'],true);
 assert.equal(tableRows(r).length,2);
 await update({categories:[]});
 assert.match(text(r.toJSON()),/대분류를 먼저 추가하세요/);
 assert.equal(r.root.findAll(n=>n.type==='button'&&text(n.children)==='세부 항목 추가').length,0);
 assert.equal(tableRows(r).length,0);
});
