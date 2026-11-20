import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as query from '@tanstack/react-query';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';

const receipts=[{id:11,filename:'receipt.png',mime:'image/png',size_bytes:512},{id:12,filename:'invoice.pdf',mime:'application/pdf',size_bytes:1024}];
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const button=(r,label)=>r.root.findAll(n=>n.type==='button'&&text(n.children).trim()===label)[0];
const settle=()=>new Promise(resolve=>setTimeout(resolve,15));

async function mount({component='ExpenseAttachmentViewer',files=receipts,lazy=false,failDetail=false,badImage=false,native=false,initialReceiptId,downloadResult}={}){
 const calls={details:[],blobs:[],downloads:[],created:[],revoked:[],opened:0,openedReceipts:[]},state={failDetail},observers=[];
 const qc=new query.QueryClient({defaultOptions:{queries:{retry:false,retryDelay:0,gcTime:Infinity}}});
 const api={
  expenseDetail:async id=>{calls.details.push(id);if(state.failDetail)throw Error('접근할 수 없습니다.');return {receipts:files};},
  downloadExpenseReceipt:async(id,rid)=>{calls.blobs.push([id,rid]);return new Blob(['fixture'],{type:badImage?'text/html':files.find(file=>file.id===rid).mime});},
 };
 const context=vm.createContext({console,window:native?{GpsNative:{}}:{},URL:{
  createObjectURL:blob=>{const url=`blob:receipt-${calls.created.length}`;calls.created.push({blob,url});return url;},
  revokeObjectURL:url=>calls.revoked.push(url),
 },...(lazy?{IntersectionObserver:class{constructor(callback){this.callback=callback;observers.push(this);}observe(){}disconnect(){}}}:{})});
 const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});
 const source=await readFile(new URL('../src/components/business/ExpenseAttachments.jsx',import.meta.url),'utf8');
 const code=(await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const mod=new vm.SourceTextModule(code,{context});
 const common={default:()=>null,api,
  downloadReceipt:async(...args)=>{calls.downloads.push(args);return typeof downloadResult==='function'?downloadResult(...args):downloadResult;},
  Modal:({children,title})=>React.createElement('section',{role:'dialog','aria-label':title},children),
  BusinessButton:({children,...props})=>React.createElement('button',props,children),
  BusinessError:({children,onRetry})=>React.createElement('div',{role:'alert'},children,React.createElement('button',{onClick:onRetry},'다시 시도')),
 };
 const real={'react':React,'react/jsx-runtime':jsx,'@tanstack/react-query':query};
 await mod.link(name=>moduleOf(real[name]||common));await mod.evaluate();
 let r;
 await act(async()=>{r=create(React.createElement(query.QueryClientProvider,{client:qc},React.createElement(mod.namespace[component],{expenseId:7,initialReceiptId,count:files.length,receipts:files,onOpen:id=>{calls.opened++;calls.openedReceipts.push(id);},onClose:()=>{}})),{createNodeMock:()=>({})});await settle();});
 await act(settle);await act(settle);
 return {r,calls,state,qc,observers,close:async()=>{await act(async()=>r.unmount());qc.clear();}};
}

test('receipt thumbnails defer authenticated requests until visible and revoke their object URL',async()=>{
 const {r,calls,observers,close}=await mount({component:'ExpenseReceiptThumbnail',files:[receipts[1],receipts[0]],lazy:true});
 try{
  assert.equal(calls.details.length,0);assert.equal(calls.blobs.length,0);
  await act(async()=>{observers[0].callback([{isIntersecting:true}]);await settle();});await act(settle);await act(settle);
  assert.deepEqual(calls.details,[7]);assert.deepEqual(calls.blobs,[[7,11]],'the first image is selected even when a PDF was uploaded first');
  assert.equal(r.root.findByType('img').props.src,'blob:receipt-0');
  await act(async()=>r.root.findByProps({'aria-label':'지출 7 첨부파일 2개 보기'}).props.onClick());
  assert.equal(calls.opened,1);
 }finally{await close();}
 assert.deepEqual(calls.revoked,['blob:receipt-0']);
});

test('attachment navigation clears image URLs and PDF content is fetched only on download',async()=>{
 const {r,calls,close}=await mount();
 try{
  assert.equal(r.root.findByType('img').props.alt,'receipt.png');
  assert.deepEqual(calls.blobs,[[7,11]]);
  await act(async()=>r.root.findByProps({'aria-label':'다음 첨부파일'}).props.onClick());
  assert.equal(r.root.findAllByType('img').length,0);assert.match(text(r.toJSON()),/PDF 첨부파일/);
  assert.deepEqual(calls.revoked,['blob:receipt-0']);assert.deepEqual(calls.blobs,[[7,11]]);
  await act(async()=>button(r,'PDF 다운로드').props.onClick());
  assert.deepEqual(calls.blobs,[[7,11],[7,12]]);assert.equal(calls.downloads[0][1],'invoice.pdf');assert.equal(calls.downloads[0][2],false);
  await act(async()=>r.root.findByProps({'aria-label':'이전 첨부파일'}).props.onClick());
  assert.equal(r.root.findByType('img').props.src,'blob:receipt-1');assert.equal(calls.blobs.length,2,'returning to an image reuses its authenticated blob');
  await act(async()=>button(r,'원본 다운로드').props.onClick());
  assert.equal(calls.downloads[1][1],'receipt.png');assert.equal(calls.downloads[1][2],false);
 }finally{await close();}
 assert.deepEqual(calls.revoked,['blob:receipt-0','blob:receipt-1']);
});

test('failed metadata can be retried and unsupported response content is never embedded',async()=>{
 const {r,calls,state,close}=await mount({failDetail:true,badImage:true});
 try{
  assert.match(text(r.toJSON()),/첨부파일 목록을 불러오지 못했습니다/);assert.equal(calls.blobs.length,0);
  state.failDetail=false;
  await act(async()=>{await button(r,'다시 시도').props.onClick();await settle();});await act(settle);await act(settle);
  assert.match(text(r.toJSON()),/이미지를 미리 볼 수 없습니다/);
  assert.equal(r.root.findAllByType('img').length,0);assert.equal(calls.created.length,0);
 }finally{await close();}
});

test('native image downloads keep the existing image-to-PDF bridge behavior',async()=>{
 const {r,calls,close}=await mount({native:true,files:[receipts[0]]});
 try{
  assert.equal(button(r,'원본 다운로드'),undefined);
  await act(async()=>button(r,'PDF 다운로드').props.onClick());
  assert.equal(calls.downloads[0][2],true);assert.deepEqual(calls.blobs,[[7,11]]);
 }finally{await close();}
});

test('attachment file choices open the requested receipt and preserve selection across a refreshed order',async()=>{
 const {r,calls,qc,close}=await mount({initialReceiptId:12});
 try{
  const group=r.root.findByProps({'aria-label':'첨부파일 선택'});
  assert.equal(group.findByProps({title:'invoice.pdf'}).props['aria-pressed'],true);
  assert.equal(r.root.findAllByType('img').length,0);
  assert.equal(calls.blobs.length,0,'opening a PDF does not fetch another image for preview');
  await act(async()=>group.findByProps({title:'receipt.png'}).props.onClick());await act(settle);await act(settle);
  assert.equal(r.root.findByType('img').props.alt,'receipt.png');
  await act(async()=>{qc.setQueryData(['expense-detail',7],{receipts:[receipts[1],receipts[0]]});await settle();});
  assert.equal(r.root.findByProps({'aria-label':'첨부파일 선택'}).findByProps({title:'receipt.png'}).props['aria-pressed'],true);
  assert.equal(r.root.findByType('img').props.alt,'receipt.png');
  assert.match(text(r.root.findByProps({className:'expense-attachment-heading'}).children),/2 \/ 2/);
 }finally{await close();}
});

test('attachment download locks file choices and cannot start twice before state renders',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;});
 const {r,calls,close}=await mount({downloadResult:pending});
 try{
  const run=button(r,'PDF 다운로드').props.onClick;
  await act(async()=>{run();run();});
  assert.equal(calls.downloads.length,1);
  assert.equal(r.root.findByProps({title:'invoice.pdf'}).props.disabled,true);
  assert.equal(r.root.findByProps({'aria-label':'다음 첨부파일'}).props.disabled,true);
  assert.equal(button(r,'다운로드 중…').props.disabled,true);
  await act(async()=>release());
  assert.equal(r.root.findByProps({title:'invoice.pdf'}).props.disabled,false);
  assert.equal(button(r,'PDF 다운로드').props.disabled,false);
 }finally{release();await close();}
});

test('drawer image and thumbnail choices share authenticated blobs and expand the selected file',async()=>{
 const files=[...receipts,{id:13,filename:'second.webp',mime:'image/webp',size_bytes:2048}];
 const {r,calls,close}=await mount({component:'ExpenseInlineAttachments',files});
 try{
  assert.equal(calls.details.length,0,'the drawer supplies metadata without another detail request');
  assert.deepEqual(calls.blobs.map(call=>call[1]).sort((a,b)=>a-b),[11,13],'large image and thumbnails share one fetch for each image');
  assert.equal(r.root.findByProps({className:'expense-inline-image'}).findByType('img').props.alt,'receipt.png');
  await act(async()=>r.root.findByProps({'aria-label':'invoice.pdf 선택'}).props.onClick());
  assert.equal(r.root.findAllByProps({className:'expense-inline-image'}).length,0);
  await act(async()=>button(r,'파일 보기').props.onClick());
  assert.deepEqual(calls.openedReceipts,[12]);
  await act(async()=>r.root.findByProps({'aria-label':'second.webp 선택'}).props.onClick());
  assert.equal(r.root.findByProps({className:'expense-inline-image'}).findByType('img').props.alt,'second.webp');
  await act(async()=>button(r,'크게 보기').props.onClick());
  assert.deepEqual(calls.openedReceipts,[12,13]);assert.equal(calls.blobs.length,2);
 }finally{await close();}
 assert.deepEqual(new Set(calls.revoked),new Set(calls.created.map(item=>item.url)),'every mounted image object URL is revoked');
});

test('a failed attachment download preserves the selected file and permits a clean retry',async()=>{
 let attempts=0;
 const {r,calls,close}=await mount({initialReceiptId:12,downloadResult:()=>{if(++attempts===1)throw Error('파일 저장 실패');}});
 try{
  await act(async()=>button(r,'PDF 다운로드').props.onClick());
  assert.match(text(r.toJSON()),/파일 저장 실패/);
  assert.equal(button(r,'PDF 다운로드').props.disabled,false);
  assert.equal(r.root.findByProps({'aria-label':'첨부파일 선택'}).findByProps({title:'invoice.pdf'}).props['aria-pressed'],true);
  await act(async()=>button(r,'PDF 다운로드').props.onClick());
  assert.doesNotMatch(text(r.toJSON()),/파일 저장 실패/);
  assert.deepEqual(calls.downloads.map(args=>args[1]),['invoice.pdf','invoice.pdf']);
  assert.equal(r.root.findByProps({'aria-label':'첨부파일 선택'}).findByProps({title:'invoice.pdf'}).props.disabled,false);
 }finally{await close();}
});
