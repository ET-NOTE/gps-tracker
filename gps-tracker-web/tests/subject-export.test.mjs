import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
import {subjectReport,subjectScopeNote} from '../src/lib/subjectReport.js';
import {reportCsv,reportPdfDefinition} from '../src/lib/businessExport.js';

async function mount(prepareExport,save,props={}) {
 const context=vm.createContext({console,document:new EventTarget()});
 const source=await readFile(new URL('../src/components/business/ExportButtons.jsx',import.meta.url),'utf8');
 const m=new vm.SourceTextModule((await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code,{context});
 await m.link(async name=>{
  const values=name==='react'?React:name==='react/jsx-runtime'?jsx:name.includes('BusinessWorkspace')?{BusinessButton:p=>React.createElement('button',p,p.children)}:name.includes('downloadReport')?{downloadReport:save}:name==='../Icon'?{default:()=>null}:{Modal:p=>React.createElement('aside',{},p.children)};
  return new vm.SyntheticModule(Object.keys(values),function(){for(const[k,v]of Object.entries(values))this.setExport(k,v);},{context});
 });await m.evaluate();let r;
 await act(async()=>{r=create(React.createElement(m.namespace.default,{report:{rows:[{secret:'previous-scope'}]},prepareExport,...props}));});
 return r;
}
test('the download disclosure exposes each format and closes after selecting its matching report',async()=>{
 const saves=[];
 const r=await mount(undefined,async(report,format)=>{saves.push([report.title,format]);return {};},
   {grouped:true,csvReport:{title:'표 데이터'},pdfReport:{title:'인쇄 서식'}});
 const trigger=()=>r.root.findByProps({className:'business-button business-export-trigger'});
 const options=()=>r.root.findByProps({role:'group','aria-label':'파일 형식'});
 assert.equal(trigger().props['aria-controls'],options().props.id);
 for(const [index,label] of ['CSV 다운로드','PDF 다운로드'].entries()){
   assert.equal(trigger().props['aria-expanded'],false);assert.equal(options().props.hidden,true);
   await act(async()=>trigger().props.onClick());assert.equal(trigger().props['aria-expanded'],true);assert.equal(options().props.hidden,false);
   const button=options().findAllByType('button')[index];assert.equal(button.props.children,label);
   await act(async()=>button.props.onClick());
 }
 assert.deepEqual(saves,[['표 데이터','csv'],['인쇄 서식','pdf']]);assert.equal(options().props.hidden,true);
 await act(async()=>r.unmount());
});
test('CSV and PDF save only the newly authorized response, including a now-empty scope',async()=>{
 const formats=[],saves=[];const r=await mount(async format=>{formats.push(format);return {rows:[],scope:'rechecked'};},async(report,format)=>{saves.push({report,format});return {};});
 for (const i of [0,1]) await act(async()=>r.root.findAllByType('button')[i].props.onClick());
 assert.deepEqual(formats,['csv','pdf']);assert.equal(saves.length,2);assert.ok(saves.every(s=>s.report.rows.length===0&&s.report.scope==='rechecked'));
 await act(async()=>r.unmount());
});
test('failed reauthorization cannot fall back to the cached report',async()=>{
 let saves=0;const r=await mount(async()=>{throw Error('제공 중지');},async()=>saves++);
 await act(async()=>r.root.findAllByType('button')[0].props.onClick());
 assert.equal(saves,0);assert.match(JSON.stringify(r.toJSON()),/제공 중지/);await act(async()=>r.unmount());
});
test('leaving the company screen while authorization is pending cancels export',async()=>{
 let release,saves=0;const promise=new Promise(r=>release=r);const r=await mount(()=>promise,async()=>saves++);
 await act(async()=>{r.root.findAllByType('button')[0].props.onClick();});
 await act(async()=>r.unmount());await act(async()=>release({rows:[]}));assert.equal(saves,0);
});
test('partial scope warning survives CSV and PDF serialization even for no visible trips',()=>{
 const report=subjectReport({title:'운행',filename:'test',columns:[{key:'km',label:'거리'}],rows:[],meta:[],footer:''},true);
 assert.ok(reportCsv(report).includes(subjectScopeNote));assert.ok(JSON.stringify(reportPdfDefinition(report)).includes(subjectScopeNote));
 assert.ok(report.warnings.includes(subjectScopeNote));
});
