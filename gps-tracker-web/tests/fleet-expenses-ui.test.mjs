import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as query from '@tanstack/react-query';
import {create,act} from 'react-test-renderer';
import {transform} from 'esbuild';
import * as business from '../src/lib/business.js';
import * as businessExport from '../src/lib/businessExport.js';
import * as expenses from '../src/lib/fleetExpenses.js';
import * as sites from '../src/lib/fleetSites.js';

const rows=[
 {id:1,status:'approved',amount_krw:50000,spent_on:'2026-11-17',staff_id:1,staff_name:'김영업',department_id:1,department_name:'영업팀',vehicle_id:100,vehicle_name:'업무 차량 123가4567',category_id:2,category_name:'유류비',group_name:'차량유지비',payment_method:'company_card'},
 {id:2,status:'pending',amount_krw:80000,spent_on:'2026-11-17',staff_id:1,staff_name:'김영업',department_id:1,department_name:'영업팀',vehicle_id:null,vehicle_name:'일반 지출',category_id:3,category_name:'숙박비',group_name:'여비교통비',payment_method:'personal_card'},
 {id:3,status:'rejected',amount_krw:20000,spent_on:'2026-11-16',staff_id:2,staff_name:'이관리',department_id:2,department_name:'관리팀',vehicle_id:101,vehicle_name:'관리 차량 222나1111',category_id:3,category_name:'숙박비',group_name:'여비교통비',payment_method:'personal_card'},
];
const text=node=>typeof node==='string'||typeof node==='number'?String(node):Array.isArray(node)?node.map(text).join(''):text(node?.children||[]);
const button=(r,label)=>r.root.findAll(n=>n.type==='button'&&text(n.children).trim()===label)[0];
const settle=()=>new Promise(resolve=>setTimeout(resolve,12));

test('approval inbox shows only reviewable requests and keeps the same scope on download',async()=>{
 const data=[...rows.map(r=>({...r,can_review:true})),{...rows[1],id:4,can_review:false}];
 const {r,close}=await mount(data,{approvalsOnly:true});
 try{
  assert.equal(button(r,'승인 대기1').props['aria-pressed'],true);
  assert.equal(button(r,'지출 등록'),undefined);
  assert.equal(r.root.findByType('tbody').findAllByType('tr').length,1);
  await act(async()=>button(r,'다운로드').props.onClick());
  assert.equal(r.root.findByType('export-preview').props.report.rows.length,1);
  assert.equal(r.root.findByType('export-preview').props.report.rows[0].amount,80000);
  await act(async()=>button(r,'반려1').props.onClick());
  assert.equal(r.root.findByProps({label:'승인 관리 조회 요약'}).props.items.find(item=>item.name==='반려').value,1);
 }finally{await close();}
});

async function mount(data=rows,{limit=false,onOpenCategories,categoriesOnly=false,approvalsOnly=false,initialScope,assetQuery,detail={},api:apiOverrides={},mockup=false}={}){
 const requests=[],state={fail:false,limit};
 const qc=new query.QueryClient({defaultOptions:{queries:{retry:false,staleTime:Infinity,gcTime:Infinity}}});
 const api={expenseCategories:async()=>[{id:1,kind:'group',name:'차량유지비'},{id:2,kind:'fuel',parent_id:1,name:'유류비'},{id:3,kind:'expense',parent_id:1,name:'숙박비'}],listExpenses:async filters=>{
  requests.push({...filters});if(state.fail)throw Error('지출 조회 실패');
  const items=data.filter(r=>['vehicle_id','staff_id','department_id','category_id','status'].every(k=>!filters[k]||String(r[k])===filters[k]));
  if(state.limit&&items.length>1000)throw Object.assign(Error('조회 결과가 1,000건을 넘습니다. 기간이나 필터를 좁혀 주세요.'),{status:400});
  return {items};
 },expenseDetail:async id=>({expense:{...data.find(row=>row.id===id),...detail.expense},receipts:detail.receipts||[],history:detail.history||[]}),...apiOverrides};
 const context=vm.createContext({console});
 const moduleOf=exports=>new vm.SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});
 const source=await readFile(new URL('../src/components/business/FleetExpenses.jsx',import.meta.url),'utf8');
 const code=(await transform(source,{loader:'jsx',jsx:'automatic',format:'esm'})).code;
 const mod=new vm.SourceTextModule(code,{context});
 const body=({children})=>React.createElement('section',{},children);
 const tag=type=>({children,...props})=>React.createElement(type,props,children);
 const noop=()=>null;
 const common={default:noop,api,useStaff:()=>({data:[{id:1,name:'김영업',active:true},{id:2,name:'이관리',active:true}]}),
  useFleetAccess:()=>({manage_team:true,manage_reports:true}),useFleetOrganization:()=>({data:[{id:1,name:'영업팀',kind:'department'},{id:2,name:'관리팀',kind:'department'}]}),
  useFleetAssets:()=>assetQuery??({data:[{id:100,name:'업무 차량'},{id:101,name:'관리 차량'}]}),downloadReceipt:noop,
  BusinessSection:body,BusinessButton:tag('button'),BusinessEmpty:({title})=>React.createElement('p',{},title),
  ExpenseReceiptThumbnail:props=>React.createElement('receipt-thumbnail',props),ExpenseInlineAttachments:props=>React.createElement('receipt-panel',props),ExpenseAttachmentViewer:props=>React.createElement('receipt-viewer',props),
  BusinessError:({children,onRetry})=>React.createElement('div',{role:'alert'},children,React.createElement('button',{onClick:onRetry},'다시 시도')),
  Modal:({children,footer,title})=>React.createElement('section',{role:'dialog','aria-label':title},children,footer),
  FormField:body,Input:tag('input'),Select:tag('select'),Textarea:tag('textarea'),Button:tag('button')};
 const real={'react':React,'react/jsx-runtime':jsx,'@tanstack/react-query':query,'../../lib/business':business,'../../lib/businessExport':businessExport,'../../lib/fleetExpenses':expenses,'../../lib/fleetSites':sites};
 real['../../lib/mockupHidden']={hideOutsideMockup:mockup};
 real['./ExpenseCategorySettings']={default:({categories,onEdit,canManage})=>React.createElement('category-settings',{categories,onEdit,canManage})};
 await mod.link(name=>moduleOf(real[name]||(name==='./ExportButtons'?{default:props=>React.createElement('export-preview',props)}:name==='./BusinessDrawer'?{default:({children,title,onClose})=>React.createElement('section',{role:'dialog','aria-label':title,'data-view':'drawer',onClose},children)}:common)));
 await mod.evaluate();
 let r;
 await act(async()=>{r=create(React.createElement(query.QueryClientProvider,{client:qc},React.createElement(mod.namespace.default,{onOpenCategories,categoriesOnly,approvalsOnly,initialScope})));await settle();});
 await act(settle);
 return {r,requests,state,qc,close:async()=>{await act(async()=>r.unmount());qc.clear();}};
}

test('expense category management remains available when vehicles cannot be loaded',async()=>{
 const {r,requests,close}=await mount(rows,{categoriesOnly:true,assetQuery:{error:Error('차량 조회 실패')}});
 try{
  const settings=r.root.findByType('category-settings');
  assert.equal(settings.props.categories.length,3);
  assert.equal(settings.props.canManage,true);
  await act(async()=>settings.props.onEdit(settings.props.categories[0]));
  assert.equal(r.root.findByProps({role:'dialog'}).props['aria-label'],'대분류 수정');
  assert.deepEqual(requests,[]);
 }finally{await close();}
});

test('analytics drilldown preserves the status, general expenses and historical department in the ledger and download',async()=>{
 const data=[...rows, {...rows[1],id:4,status:'approved',department_id:null,department_name:'이전 부서'},
   {...rows[1],id:5,status:'pending',department_id:null,department_name:'이전 부서'}];
 const initialScope={filters:{from:'2026-11-01',to:'2026-11-30',vehicle_id:'general',department_id:'name:이전 부서',category_id:'3'},status:'approved'};
 const {r,requests,close}=await mount(data,{initialScope});
 try {
   assert.deepEqual(requests[0],{from:'2026-11-01',to:'2026-11-30',category_id:'3'});
   assert.equal(r.root.findByProps({'aria-label':'조회 부서'}).props.value,'name:이전 부서');
   assert.equal(button(r,'승인 완료1').props['aria-pressed'],true);
   assert.equal(r.root.findByType('tbody').findAllByType('tr').length,1);
   await act(async()=>button(r,'다운로드').props.onClick());
   const report=r.root.findByType('export-preview').props.report;
   assert.equal(report.rows.length,1);
   assert.equal(report.rows[0].department,'이전 부서');
   assert.equal(report.rows[0].status,'승인');
 }finally{await close();}
});

test('expense status and search controls share the displayed rows with download and summary',async()=>{
 const {r,requests,close}=await mount();
 try{
  assert.equal(r.root.findAllByProps({'aria-label':'승인 비용 집계'}).length,0);
  assert.equal(button(r,'전체 지출3').props['aria-pressed'],true);
  assert.equal(button(r,'승인 완료1').props['aria-pressed'],false);
  assert.equal(requests.length,1);assert.equal(requests[0].status,undefined);
  await act(async()=>button(r,'승인 대기1').props.onClick());
  assert.equal(r.root.findByType('tbody').findAllByType('tr').length,1);
  assert.equal(r.root.findByProps({label:'조회된 지출 요약'}).props.items.find(item=>item.name==='승인 완료').value,0);
  await act(async()=>button(r,'다운로드').props.onClick());
  assert.equal(r.root.findByType('export-preview').props.report.rows[0].status,'승인대기');
  await act(async()=>button(r,'지출 설정').props.onClick());
  await act(async()=>button(r,'비용 집계').props.onClick());
  assert.match(text(r.toJSON()),/승인된 지출이 없습니다/);
  await act(async()=>r.root.findByProps({'aria-label':'차량, 거래처, 요청자 검색'}).props.onChange({target:{value:'관리 차량'}}));
  assert.ok(button(r,'전체 지출1'));assert.ok(button(r,'승인 대기0'));assert.ok(button(r,'반려1'));
  assert.equal(r.root.findByType('tbody').findAllByType('tr').length,0);
  assert.equal(r.root.findAllByType('export-preview').length,0);
  assert.equal(requests.length,1,'local search and status selection do not change the server scope');
 }finally{await close();}
});

test('advanced filters remain drafts until applied, cancelling and resetting preserve scope',async()=>{
 const {r,requests,close}=await mount();
 try{
  await act(async()=>button(r,'필터').props.onClick());
  await act(async()=>r.root.findByProps({'aria-label':'지출 차량 필터'}).props.onChange({target:{value:'100'}}));
  assert.equal(requests.length,1);
  await act(async()=>button(r,'취소').props.onClick());
  assert.equal(r.root.findAllByProps({role:'dialog'}).length,0);
  await act(async()=>button(r,'필터').props.onClick());
  assert.equal(r.root.findByProps({'aria-label':'지출 차량 필터'}).props.value,'');
  await act(async()=>r.root.findByProps({'aria-label':'지출 차량 필터'}).props.onChange({target:{value:'100'}}));
  await act(async()=>{button(r,'적용').props.onClick();await settle();});await act(settle);
  assert.equal(requests.at(-1).vehicle_id,'100');assert.equal(requests.at(-1).status,undefined);
  assert.ok(button(r,'필터1'));assert.ok(button(r,'전체 지출1'));
  await act(async()=>button(r,'필터1').props.onClick());
  await act(async()=>button(r,'초기화').props.onClick());
  assert.equal(requests.at(-1).vehicle_id,'100');
  await act(async()=>{button(r,'적용').props.onClick();await settle();});await act(settle);
  assert.ok(button(r,'전체 지출3'));assert.ok(button(r,'필터'));
  assert.equal(requests[0].from,requests[1].from);assert.equal(requests[0].to,requests[1].to);
 }finally{await close();}
});

test('a failed refresh or invalid range hides cached rows, counts, totals and summary',async()=>{
 const {r,state,qc,requests,close}=await mount();
 try{
  await act(async()=>button(r,'지출 설정').props.onClick());
  await act(async()=>button(r,'비용 집계').props.onClick());
  assert.equal(r.root.findAllByProps({'aria-label':'승인 비용 집계'}).length,1);
  state.fail=true;
  await act(async()=>{await qc.invalidateQueries({queryKey:['fleet-expenses']});await settle();});
  assert.equal(r.root.findAllByType('table').length,0);
  assert.equal(r.root.findAllByProps({'aria-label':'승인 비용 집계'}).length,0);
  assert.ok(button(r,'전체 지출—'));assert.equal(button(r,'다운로드').props.disabled,true);
  assert.match(text(r.toJSON()),/지출 조회 실패/);
  const calls=requests.length;
  await act(async()=>button(r,'승인 완료—').props.onClick());
  assert.equal(requests.length,calls,'ordinary fetch errors do not trigger a fallback request');
  state.fail=false;
  await act(async()=>{await button(r,'다시 시도').props.onClick();await settle();});
  assert.equal(r.root.findAllByType('table').length,1);
  await act(async()=>r.root.findByProps({'aria-label':'지출 조회 시작일'}).props.onChange({target:{value:''}}));
  assert.equal(r.root.findAllByType('table').length,0);assert.ok(button(r,'전체 지출—'));
  assert.equal(r.root.findAllByProps({'aria-label':'승인 비용 집계'}).length,0);
  assert.equal(button(r,'다운로드').props.disabled,true);assert.match(text(r.toJSON()),/조회 기간을 확인/);
 }finally{await close();}
});

test('over-limit results can still be narrowed by server status without fabricated total counts',async()=>{
 const data=Array.from({length:1200},(_,i)=>({...rows[i<600?0:1],id:i+1}));
 const {r,requests,close}=await mount(data,{limit:true});
 try{
  assert.ok(button(r,'전체 지출—'));assert.match(text(r.toJSON()),/1,000건/);
  assert.equal(button(r,'다운로드').props.disabled,true);
  await act(async()=>{button(r,'승인 완료—').props.onClick();await settle();});await act(settle);
  assert.equal(requests.at(-1).status,'approved');assert.ok(button(r,'승인 완료600'));
  assert.ok(button(r,'전체 지출—'));assert.ok(button(r,'승인 대기—'));
  assert.match(text(r.toJSON()),/다른 상태의 건수는 미집계/);
  assert.equal(r.root.findByType('tbody').findAllByType('tr').length,25);
  await act(async()=>button(r,'다운로드').props.onClick());
  assert.equal(r.root.findByType('export-preview').props.report.rows.length,600);
  await act(async()=>{button(r,'승인 대기—').props.onClick();await settle();});await act(settle);
  assert.equal(requests.at(-1).status,'pending');assert.ok(button(r,'승인 대기600'));assert.ok(button(r,'승인 완료—'));
  assert.equal(r.root.findByProps({label:'조회된 지출 요약'}).props.items.find(item=>item.name==='승인 완료').value,0);
  await act(async()=>button(r,'필터').props.onClick());
  await act(async()=>r.root.findByProps({'aria-label':'지출 차량 필터'}).props.onChange({target:{value:'100'}}));
  await act(async()=>{button(r,'적용').props.onClick();await settle();});await act(settle);
  assert.equal(requests.at(-1).vehicle_id,'100');assert.equal(requests.at(-1).status,undefined);
  assert.ok(button(r,'전체 지출600'));assert.ok(button(r,'승인 완료600'));assert.ok(button(r,'승인 대기0'));
  assert.doesNotMatch(text(r.toJSON()),/다른 상태의 건수는 미집계/);
 }finally{await close();}
});

test('search and status changes reset pagination and exports include the full filtered set',async()=>{
 const data=Array.from({length:30},(_,i)=>({...rows[i===29?1:0],id:i+1}));
 const {r,close}=await mount(data);
 try{
  await act(async()=>r.root.findByProps({'aria-label':'다음 페이지'}).props.onClick());
  assert.equal(r.root.findByType('tbody').findAllByType('tr').length,5);
  await act(async()=>button(r,'승인 완료29').props.onClick());
  assert.equal(r.root.findByProps({'aria-label':'이전 페이지'}).props.disabled,true);
  assert.equal(r.root.findByType('tbody').findAllByType('tr').length,25);
  await act(async()=>button(r,'다운로드').props.onClick());
  assert.equal(r.root.findByType('export-preview').props.report.rows.length,29);
  await act(async()=>r.root.findByProps({'aria-label':'다음 페이지'}).props.onClick());
  await act(async()=>r.root.findByProps({'aria-label':'차량, 거래처, 요청자 검색'}).props.onChange({target:{value:'업무 차량'}}));
  assert.equal(r.root.findByProps({'aria-label':'이전 페이지'}).props.disabled,true);
 }finally{await close();}
});

test('memo and receipt controls open the correct record while the date retains detail access',async()=>{
 const data=rows.map((r,i)=>({...r,note:i===0?'거래처 방문\n주차비 정산':i===1?'   ':'',receipt_count:i===0?2:0}));
 const {r,close}=await mount(data,{detail:{receipts:[{id:11,filename:'주차.png',mime:'image/png',size_bytes:1024}]}});
 try{
  assert.equal(r.root.findAllByProps({'aria-label':'메모 없음'}).length,2);
  assert.equal(r.root.findAllByProps({'aria-label':'첨부파일 없음'}).length,2);
  assert.doesNotMatch(text(r.root.findByType('tbody').children),/거래처 방문/,'long memo stays out of the compact table');
  await act(async()=>r.root.findByProps({'aria-label':'지출 1 메모 보기'}).props.onClick());
  assert.match(text(r.root.findByProps({'aria-label':'지출 메모'}).children),/거래처 방문\n주차비 정산/);
  await act(async()=>{button(r,'지출 상세 보기').props.onClick();await settle();});
  assert.equal(r.root.findAllByProps({'aria-label':'지출 메모'}).length,0);
  assert.equal(r.root.findAllByProps({'aria-label':'지출 상세'}).length,1);
  await act(async()=>button(r,'닫기').props.onClick());
  const thumbnail=r.root.findByType('receipt-thumbnail');
  assert.equal(thumbnail.props.expenseId,1);assert.equal(thumbnail.props.count,2);
  await act(async()=>{thumbnail.props.onOpen();await settle();});await act(settle);
  assert.equal(r.root.findAllByProps({'aria-label':'지출 상세'}).length,1);
  assert.equal(r.root.findByType('receipt-panel').props.expenseId,1);
  await act(async()=>r.root.findByType('receipt-panel').props.onOpen(11));
  assert.equal(r.root.findByType('receipt-viewer').props.expenseId,1);
  await act(async()=>r.root.findByType('receipt-viewer').props.onClose());
  await act(async()=>{r.root.findByProps({'aria-label':'지출 2 상세'}).props.onClick();await settle();});
  assert.equal(r.root.findAllByProps({'aria-label':'지출 상세'}).length,1);
 }finally{await close();}
});

test('expense settings route to categories and never overlap the download menu',async()=>{
 let opened=0;
 const {r,close}=await mount(rows,{onOpenCategories:()=>opened++});
 try{
  await act(async()=>button(r,'다운로드').props.onClick());
  assert.equal(r.root.findAllByType('export-preview').length,1);
  await act(async()=>button(r,'지출 설정').props.onClick());
  assert.equal(r.root.findAllByType('export-preview').length,0);
  assert.equal(button(r,'지출 설정').props['aria-expanded'],true);
  await act(async()=>button(r,'지출 항목 관리').props.onClick());
  assert.equal(opened,1);assert.equal(button(r,'지출 설정').props['aria-expanded'],false);
  await act(async()=>button(r,'지출 설정').props.onClick());
  await act(async()=>button(r,'다운로드').props.onClick());
  assert.equal(r.root.findAllByProps({'aria-label':'지출 설정 옵션'}).length,0);
 }finally{await close();}
});

test('manual refresh invalidates receipt metadata together with the expense count',async()=>{
 const {r,qc,requests,close}=await mount();
 try{
  qc.setQueryData(['expense-detail',1],{receipts:[{id:100,filename:'old.png'}]});
  await act(async()=>{r.root.findByProps({'aria-label':'지출 새로고침'}).props.onClick();await settle();});
  assert.equal(requests.length,2);
  assert.equal(qc.getQueryState(['expense-detail',1]).isInvalidated,true);
 }finally{await close();}
});

test('read-only expense detail keeps ledger context and opens the selected receipt without edit controls',async()=>{
 const files=[{id:11,filename:'주차.png',mime:'image/png',size_bytes:1024},{id:12,filename:'청구서.pdf',mime:'application/pdf',size_bytes:2048}];
 const {r,close}=await mount(rows,{detail:{expense:{can_edit:false,can_review:false,can_cancel:false,note:'고객 방문'},receipts:files}});
 try{
  await act(async()=>{r.root.findByProps({'aria-label':'지출 1 상세'}).props.onClick();await settle();});await act(settle);
  assert.equal(r.root.findByProps({'aria-label':'지출 상세'}).props['data-view'],'drawer');
  assert.equal(r.root.findAllByType('table').length,1,'the ledger remains mounted behind the drawer');
  assert.match(text(r.root.findByProps({className:'expense-detail-content'}).children),/50,000원.*기본 정보.*고객 방문/);
  assert.equal(button(r,'수정'),undefined);assert.equal(button(r,'제외'),undefined);
  assert.equal(r.root.findAllByProps({type:'file'}).length,0);
  assert.equal(button(r,'승인'),undefined);assert.equal(button(r,'반려'),undefined);assert.equal(button(r,'지출 취소'),undefined);
  await act(async()=>r.root.findByProps({'aria-label':'청구서.pdf 미리보기'}).props.onClick());
  const viewer=r.root.findByType('receipt-viewer');
  assert.equal(viewer.props.expenseId,1);assert.equal(viewer.props.initialReceiptId,12);
  await act(async()=>viewer.props.onClose());
  assert.equal(r.root.findAllByType('receipt-viewer').length,0);
  assert.equal(r.root.findAllByProps({'aria-label':'지출 상세'}).length,1);
 }finally{await close();}
});

test('drawer review retains required reasons and blocks duplicate mutations until settled',async()=>{
 let release;const pending=new Promise(resolve=>{release=resolve;}),reviews=[];
 const {r,close}=await mount(rows,{detail:{expense:{status:'pending',can_review:true,can_cancel:true,can_edit:true,updated_at:'snapshot-v1'}},api:{reviewExpense:async(id,payload)=>{reviews.push({id,payload});await pending;}}});
 try{
  await act(async()=>{r.root.findByProps({'aria-label':'지출 2 상세'}).props.onClick();await settle();});await act(settle);
  assert.ok(button(r,'승인'));assert.ok(button(r,'반려'));assert.ok(button(r,'지출 취소'));
  await act(async()=>button(r,'반려').props.onClick());
  assert.equal(button(r,'반려 처리').props.disabled,true);
  await act(async()=>r.root.findByProps({'aria-label':'지출 처리 사유'}).props.onChange({target:{value:'증빙 확인 필요'}}));
  const run=button(r,'반려 처리').props.onClick;
  await act(async()=>{run();run();});
  assert.equal(reviews.length,1);assert.equal(reviews[0].id,2);
  assert.deepEqual({...reviews[0].payload},{status:'rejected',note:'증빙 확인 필요',updated_at:'snapshot-v1'});
  assert.equal(button(r,'처리 중…').props.disabled,true);
  assert.equal(r.root.findByProps({'aria-label':'지출 처리 사유'}).props.disabled,true);
  assert.equal(r.root.findByProps({'aria-label':'지출 상세'}).props.onClose,undefined);
  await act(async()=>{release();await settle();});await act(settle);
  assert.equal(r.root.findAllByProps({'aria-label':'지출 처리 사유'}).length,0);
  await act(async()=>button(r,'지출 취소').props.onClick());
  assert.equal(button(r,'취소 처리').props.disabled,true);
  await act(async()=>button(r,'돌아가기').props.onClick());
  await act(async()=>button(r,'승인').props.onClick());
  assert.equal(button(r,'승인 처리').props.disabled,false,'approval keeps its optional reason');
 }finally{release();await close();}
});

test('desktop expense tabs follow the design order and the approved card sums approved amounts',async()=>{
 const {r,close}=await mount(rows,{mockup:true});
 try{
  const tabs=r.root.findByProps({'aria-label':'지출 상태 필터'}).findAllByType('button').map(n=>text(n.children).trim());
  assert.deepEqual(tabs,['전체 지출','승인 대기','승인 완료','반려']);
  const items=r.root.findByProps({label:'조회된 지출 요약'}).props.items;
  assert.deepEqual([...items.map(item=>item.name)],['조회 지출 합계','승인 완료','승인 대기','반려']);
  const approved=items.find(item=>item.name==='승인 완료');
  assert.equal(approved.value,50000);assert.equal(approved.unit,'원');
  assert.equal(items.find(item=>item.name==='승인 대기').value,1);
 }finally{await close();}
});
