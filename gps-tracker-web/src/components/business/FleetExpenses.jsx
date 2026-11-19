import React,{useEffect,useId,useRef,useState} from 'react';
import useCorporatePhone from '../../useCorporatePhone';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {useStaff} from '../../state';
import {businessDate} from '../../lib/business';
import {kstDateTime} from '../../lib/businessExport';
import {downloadReceipt} from '../../lib/downloadReport';
import {expenseTripOptions,expenseTripAmount,expenseStatus,paymentMethods,expenseActions,expenseMoney,expenseList,expenseTotals,expenseGroups,expenseReport} from '../../lib/fleetExpenses';
import {siteVehicleLabel} from '../../lib/fleetSites';
import {useFleetAccess,useFleetOrganization} from './FleetAccess';
import {useFleetAssets} from './FleetAssets';
import {BusinessSection,BusinessButton,BusinessError,BusinessEmpty} from './BusinessWorkspace';
import ExportButtons from './ExportButtons';
import ExpenseCategorySettings from './ExpenseCategorySettings';
import BusinessDrawer from './BusinessDrawer';
import {ExpenseReceiptThumbnail,ExpenseInlineAttachments,ExpenseAttachmentViewer} from './ExpenseAttachments';
import Icon from '../Icon';
import {Modal,FormField,Input,Select,Textarea,Button} from '../ui';
import './fleet-expenses.css';

export default function FleetExpenses({categoriesOnly=false,onOpenCategories}){
 const mobile=useCorporatePhone(),[datesOpen,setDatesOpen]=useState(false);
 const [toolsOpen,setToolsOpen]=useState(false);
 const access=useFleetAccess(),qc=useQueryClient(),cats=useQuery({queryKey:['expense-categories'],queryFn:()=>api.expenseCategories()}),assets=useFleetAssets(),staff=useStaff(),org=useFleetOrganization();
 const today=businessDate(),[filters,setFilters]=useState({from:`${today.slice(0,7)}-01`,to:today}),[page,setPage]=useState(0),[groupBy,setGroupBy]=useState('month'),[edit,setEdit]=useState(null),[detail,setDetail]=useState(null),[category,setCategory]=useState(null);
 const [query,setQuery]=useState(''),[status,setStatus]=useState(''),[filtersOpen,setFiltersOpen]=useState(false),[draftFilters,setDraftFilters]=useState({}),[summaryOpen,setSummaryOpen]=useState(false),[downloadsOpen,setDownloadsOpen]=useState(false);
 const [memo,setMemo]=useState(null),[settingsOpen,setSettingsOpen]=useState(false);
 const outputRef=useRef(null),settingsRef=useRef(null),downloadRef=useRef(null);
 const filterId=useId(),summaryId=useId(),downloadId=useId(),settingsId=useId();
 useEffect(()=>{
  if((!downloadsOpen&&!settingsOpen)||typeof document==='undefined')return;
  const dismiss=e=>{if(!outputRef.current?.contains(e.target)){setDownloadsOpen(false);setSettingsOpen(false);}};
  const escape=e=>{if(e.key==='Escape'){e.preventDefault();(settingsOpen?settingsRef:downloadRef).current?.querySelector('button')?.focus();setDownloadsOpen(false);setSettingsOpen(false);}};
  document.addEventListener('pointerdown',dismiss);document.addEventListener('keydown',escape);
  return()=>{document.removeEventListener('pointerdown',dismiss);document.removeEventListener('keydown',escape);};
 },[downloadsOpen,settingsOpen]);
 const valid=filters.from&&filters.to&&filters.from<=filters.to;
 const allEntries=useQuery({queryKey:['fleet-expenses',filters],queryFn:()=>api.listExpenses(filters),enabled:!categoriesOnly&&!!valid});
 // The API rejects (rather than truncates) results above 1,000. Preserve its
 // status filter as a way to narrow that scope, without inventing other counts.
 const limited=allEntries.error?.status===400&&allEntries.error.message?.includes('조회 결과가 1,000건을 넘습니다.');
 const statusFilters={...filters,status};
 const statusEntries=useQuery({queryKey:['fleet-expenses',statusFilters],queryFn:()=>api.listExpenses(statusFilters),enabled:!categoriesOnly&&!!valid&&!!limited&&!!status});
 const entries=limited&&status?statusEntries:allEntries;
 const ready=!!valid&&!!entries.data&&!entries.error&&!entries.isPending&&!entries.isFetching&&!allEntries.isFetching;
 const {rows,counts}=expenseList(ready?entries.data.items:[],{query,status}),total=expenseTotals(rows),groups=expenseGroups(rows,groupBy);
 const filter=(key,value)=>{setFilters(f=>{const next={...f,[key]:value};if(!value)delete next[key];return next;});setPage(0);setDownloadsOpen(false);};
 const advancedCount=['vehicle_id','staff_id','department_id','category_id'].filter(key=>filters[key]).length;
 const draftFilter=(key,value)=>setDraftFilters(f=>{const next={...f,[key]:value};if(!value)delete next[key];return next;});
 const openFilters=()=>{setDraftFilters(Object.fromEntries(['vehicle_id','staff_id','department_id','category_id'].filter(key=>filters[key]).map(key=>[key,filters[key]])));setFiltersOpen(true);};
 const applyFilters=()=>{setFilters(({from,to})=>({from,to,...draftFilters}));setPage(0);setDownloadsOpen(false);setFiltersOpen(false);};
 const refresh=()=>{qc.invalidateQueries({queryKey:['fleet-expenses']});qc.invalidateQueries({queryKey:['expense-detail']});qc.invalidateQueries({queryKey:['expense-categories']});};
 useEffect(()=>setPage(0),[entries.data]);
 if(categoriesOnly){
  if(cats.error)return <BusinessError onRetry={cats.refetch}>지출 항목을 불러오지 못했습니다.</BusinessError>;
  if(!cats.data)return <p className="expense-note" role="status">지출 항목 불러오는 중…</p>;
  return <div className="fleet-expenses">
   <ExpenseCategorySettings categories={cats.data} canManage={access.manage_team} onEdit={setCategory}/>
   {category&&<CategoryForm initial={category} onClose={()=>setCategory(null)} onSaved={()=>{setCategory(null);refresh();}}/>}
  </div>;
 }
 if(cats.error||assets.error||staff.error||org.error)return <BusinessError onRetry={()=>{cats.refetch();assets.refetch();staff.refetch();org.refetch();}}>지출 입력 정보를 불러오지 못했습니다.</BusinessError>;
 if(!cats.data||!assets.data||!staff.data||!org.data)return <p className="expense-note">지출 정보 불러오는 중…</p>;
 const departments=org.data.filter(i=>i.kind==='department');
 const refreshButton=<BusinessButton icon="refresh" aria-label="지출 새로고침" title="새로고침" disabled={!valid||entries.isFetching} onClick={refresh}/>;
 const selectedNames=[assets.data.find(v=>String(v.id)===filters.vehicle_id)&&siteVehicleLabel(assets.data.find(v=>String(v.id)===filters.vehicle_id)),staff.data.find(s=>String(s.id)===filters.staff_id)?.name,departments.find(d=>String(d.id)===filters.department_id)?.name,cats.data.find(c=>String(c.id)===filters.category_id)?.name,expenseStatus[status],query.trim()&&`차량·사용자 검색: ${query.trim()}`].filter(Boolean).join(' · ')||'전체 조회';
 return <div className="fleet-expenses">
 <section className="expense-controls" aria-label="지출 조회 조건">
  <div className="expense-query-row">
   {mobile&&<button type="button" className="expense-mobile-period" aria-label="지출 조회 기간 변경" aria-expanded={datesOpen} onClick={()=>setDatesOpen(!datesOpen)}>
    <Icon name="clock" size={18}/><span>{filters.from||'시작일'} ~ {filters.to||'종료일'}</span><Icon name={datesOpen?'chevron-up':'chevron-down'} size={16}/>
   </button>}
   <div className="expense-date-range" role="group" aria-label="지출 조회 기간" data-expanded={datesOpen}>
    <label><span>시작일</span><input type="date" aria-label="지출 조회 시작일" value={filters.from||''} max={filters.to||undefined} onChange={e=>filter('from',e.target.value)}/></label>
    <span aria-hidden="true">~</span>
    <label><span>종료일</span><input type="date" aria-label="지출 조회 종료일" value={filters.to||''} min={filters.from||undefined} onChange={e=>filter('to',e.target.value)}/></label>
   </div>
   <label className="expense-search"><Icon name="search" size={16}/><input type="search" aria-label="차량 및 사용자 검색" placeholder="차량·사용자 검색" value={query} onChange={e=>{setQuery(e.target.value);setPage(0);setDownloadsOpen(false);}}/></label>
   <div className="expense-query-actions">
    <BusinessButton icon="filter" aria-haspopup="dialog" aria-expanded={filtersOpen} onClick={openFilters}>필터{advancedCount>0&&<span className="expense-filter-count">{advancedCount}</span>}</BusinessButton>
    {mobile?<BusinessButton icon="settings" aria-label="지출 도구" aria-expanded={toolsOpen} onClick={()=>{setToolsOpen(!toolsOpen);setDownloadsOpen(false);setSettingsOpen(false);}}>도구</BusinessButton>:refreshButton}
   </div>
   {!mobile&&<BusinessButton primary icon="plus" onClick={()=>setEdit({})}>지출 등록</BusinessButton>}
  </div>
  {(!mobile||toolsOpen)&&<div className="expense-control-row">
   <div className="expense-status-summary">
    <div className="expense-status-tabs" role="group" aria-label="지출 상태 필터">{[['','전체'],['approved','승인'],['pending','승인대기'],['rejected','반려'],['cancelled','취소']].map(([value,label])=><button className="expense-status-tab" key={value} type="button" aria-pressed={status===value} onClick={()=>{setStatus(value);setPage(0);setDownloadsOpen(false);}}>{label} <span>({ready&&(!limited||value===status)?counts[value||'all']:'—'})</span></button>)}</div>
    <div className="expense-approved-total"><span>승인 합계</span><strong>{ready?expenseMoney(total.amount):'—'}<small>원</small></strong></div>
   </div>
   <div className="expense-output-actions" ref={outputRef}>
    {mobile&&refreshButton}
    <div className="expense-download" ref={downloadRef}><BusinessButton icon="download" disabled={!ready} aria-expanded={downloadsOpen} aria-controls={downloadId} onClick={()=>{setDownloadsOpen(open=>!open);setSettingsOpen(false);}}>다운로드</BusinessButton>{downloadsOpen&&<div className="expense-download-menu" id={downloadId}><ExportButtons disabled={!ready} report={ready?expenseReport(rows,{...filters,filterText:selectedNames}):null}/></div>}</div>
    <div className="expense-settings" ref={settingsRef}><BusinessButton icon="settings" aria-expanded={settingsOpen} aria-controls={settingsId} onClick={()=>{setSettingsOpen(open=>!open);setDownloadsOpen(false);}}>지출 설정<Icon name={settingsOpen?'chevron-up':'chevron-down'} size={14}/></BusinessButton>{settingsOpen&&<div className="expense-settings-menu" id={settingsId} role="group" aria-label="지출 설정 옵션">
     {onOpenCategories&&<BusinessButton icon="list" onClick={()=>{setSettingsOpen(false);onOpenCategories();}}>지출 항목 관리</BusinessButton>}
     <BusinessButton icon="bar" disabled={!ready} aria-pressed={summaryOpen} aria-controls={summaryId} onClick={()=>{setSummaryOpen(open=>!open);setSettingsOpen(false);}}>비용 집계{summaryOpen&&<Icon name="check" size={14}/>}</BusinessButton>
    </div>}</div>
   </div>
  </div>}
  {limited&&<p className="expense-scope-note" role="status">{status?'전체 조회가 1,000건을 넘어 선택한 상태만 조회합니다. 다른 상태의 건수는 미집계(—)입니다.':'전체 조회가 1,000건을 넘습니다. 상태를 선택하거나 기간·필터를 좁혀 주세요.'}</p>}
 </section>
 <section className="expense-ledger" aria-label="지출 내역">
 {!valid?<p role="alert" className="expense-note">조회 기간을 확인해 주세요.</p>:entries.error?<BusinessError onRetry={entries.refetch}>{entries.error.message||'지출을 불러오지 못했습니다.'}</BusinessError>:entries.isPending||entries.isFetching||allEntries.isFetching?<p className="expense-note">지출 내역 불러오는 중…</p>:<>
 {mobile?<><div className="expense-mobile-count">{status&&`${expenseStatus[status]} · `}총 <strong>{rows.length.toLocaleString()}</strong>건</div>
 <ul className="expense-mobile-list" aria-label="지출 목록">{rows.slice(page*25,(page+1)*25).map(r=><li key={r.id}>
   <button className="expense-mobile-record" type="button" onClick={()=>setDetail(r.id)}>
     <span className="business-sr-only">지출 {r.id} 상세</span>
     <span className="expense-mobile-person"><strong>{r.staff_name||'미지정'}</strong><span>{r.department_name||'부서 미지정'}</span><span className={`business-badge expense-status-${r.status}`}>{expenseStatus[r.status]}</span></span>
     <span className="expense-mobile-item"><strong>{r.category_name}</strong><span>{[r.group_name,r.vehicle_name,r.trip_started_at&&'운행 연결'].filter(Boolean).join(' · ')}</span></span>
     <strong className="expense-mobile-amount">{expenseMoney(r.amount_krw)}<small>원</small><Icon name="chevron-right" size={16}/></strong>
   </button>
   <div className="expense-mobile-meta"><span><time dateTime={r.spent_on}>{r.spent_on}</time> · {paymentMethods[r.payment_method]}</span>
     {r.note?.trim()&&<button type="button" className="expense-mobile-shortcut" aria-label={`지출 ${r.id} 메모 보기`} onClick={()=>setMemo(r)}><Icon name="message" size={17}/></button>}
     {r.receipt_count>0&&<button type="button" className="expense-mobile-shortcut" aria-label={`지출 ${r.id} 첨부파일 ${r.receipt_count}개 보기`} onClick={()=>setDetail(r.id)}><Icon name="paperclip" size={17}/>{r.receipt_count}</button>}
   </div>
 </li>)}</ul></>:<div className="fleet-asset-table-wrap" role="region" aria-label="지출 목록 · 좌우 스크롤" tabIndex={0}><table className="fleet-asset-table expense-table"><thead><tr>{['지출일','상태','사용자 · 부서','차량','지출 항목','결제수단','금액','메모','첨부파일'].map(h=><th key={h} scope="col" className={h==='금액'?'number':''}>{h}</th>)}</tr></thead><tbody>{rows.slice(page*25,(page+1)*25).map(r=><tr key={r.id}>
  <td data-label="지출일"><button type="button" className="expense-detail-link" title="지출 상세 보기" aria-label={`지출 ${r.id} 상세${r.receipt_count?` · 첨부 ${r.receipt_count}개`:''}`} onClick={()=>setDetail(r.id)}>{r.spent_on}</button></td>
  <td data-label="상태"><span className={`business-badge expense-status-${r.status}`}>{expenseStatus[r.status]}</span></td><td data-label="사용자 · 부서"><strong>{r.staff_name||'미지정'}</strong><small>{r.department_name||'부서 미지정'}</small></td><td data-label="차량">{r.vehicle_name}</td><td data-label="지출 항목">{r.category_name}<small>{r.group_name}{r.trip_started_at?' · 운행 연결':''}</small></td><td data-label="결제수단">{paymentMethods[r.payment_method]}</td><td data-label="금액" className="number">{expenseMoney(r.amount_krw)}원</td>
  <td data-label="메모" className="expense-memo-cell">{r.note?.trim()?<button type="button" className="expense-memo-button" title="메모 보기" aria-label={`지출 ${r.id} 메모 보기`} onClick={()=>setMemo(r)}><Icon name="message" size={16}/></button>:<span className="expense-muted" aria-label="메모 없음">—</span>}</td>
  <td data-label="첨부파일" className="expense-attachment-cell">{r.receipt_count>0?<ExpenseReceiptThumbnail expenseId={r.id} count={r.receipt_count} onOpen={()=>setDetail(r.id)}/>:<span className="expense-muted" aria-label="첨부파일 없음">—</span>}</td>
 </tr>)}</tbody></table></div>}
 {!rows.length&&<BusinessEmpty title="조회된 지출이 없습니다.">새 지출을 등록하거나 조회 조건을 변경하세요.</BusinessEmpty>}
 <div className="expense-pagination"><span>{rows.length}건</span><div className="expense-actions"><BusinessButton aria-label="이전 페이지" disabled={!page} onClick={()=>setPage(p=>p-1)}><Icon name="chevron-left" size={16}/></BusinessButton><span className="expense-page-number">{page+1} / {Math.max(1,Math.ceil(rows.length/25))}</span><BusinessButton aria-label="다음 페이지" disabled={(page+1)*25>=rows.length} onClick={()=>setPage(p=>p+1)}><Icon name="chevron-right" size={16}/></BusinessButton><span className="expense-page-size">25개씩 보기</span></div></div>
 </>}
 </section>
 {mobile&&<button type="button" className="expense-mobile-create" aria-label="지출 등록" title="지출 등록" onClick={()=>setEdit({})}><Icon name="plus" size={22}/><span>지출 등록</span></button>}
 {ready&&summaryOpen&&<section className="expense-summary-panel" id={summaryId} aria-label="승인 비용 집계"><header><div><h3>승인 비용 집계</h3><p>현재 목록에 있는 승인 지출만 합산합니다.</p></div><Select aria-label="집계 기준" value={groupBy} onChange={e=>setGroupBy(e.target.value)}><option value="month">월별</option><option value="vehicle">차량별</option><option value="department">부서별</option></Select></header><div className="expense-summary">{groups.length?groups.map(g=><div key={g.key}><strong>{g.label}</strong><span>{g.count}건</span><b>{expenseMoney(g.amount)}원</b></div>):<BusinessEmpty compact title="승인된 지출이 없습니다."/>}</div></section>}
 {filtersOpen&&<Modal open title="지출 필터" onClose={()=>setFiltersOpen(false)} footer={<div className="expense-filter-footer"><BusinessButton disabled={!Object.keys(draftFilters).length} onClick={()=>setDraftFilters({})}>초기화</BusinessButton><div className="expense-actions"><BusinessButton onClick={()=>setFiltersOpen(false)}>취소</BusinessButton><BusinessButton primary onClick={applyFilters}>적용</BusinessButton></div></div>}><div className="expense-filter-dialog" id={filterId}>
  <FormField label="차량"><Select aria-label="지출 차량 필터" value={draftFilters.vehicle_id||''} onChange={e=>draftFilter('vehicle_id',e.target.value)}><option value="">전체 차량·일반 지출</option>{assets.data.map(v=><option key={v.id} value={v.id}>{siteVehicleLabel(v)}</option>)}</Select></FormField>
  <FormField label="사용자"><Select aria-label="지출 사용자 필터" value={draftFilters.staff_id||''} onChange={e=>draftFilter('staff_id',e.target.value)}><option value="">전체 사용자</option>{staff.data.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</Select></FormField>
  <FormField label="부서"><Select aria-label="지출 부서 필터" value={draftFilters.department_id||''} onChange={e=>draftFilter('department_id',e.target.value)}><option value="">전체 부서</option>{departments.filter(d=>access.manage_team||d.id===access.department_id).map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</Select></FormField>
  <FormField label="지출 항목"><Select aria-label="지출 항목 필터" value={draftFilters.category_id||''} onChange={e=>draftFilter('category_id',e.target.value)}><option value="">전체 항목</option>{cats.data.filter(c=>c.kind!=='group').map(c=><option key={c.id} value={c.id}>{cats.data.find(g=>g.id===c.parent_id)?.name} · {c.name}</option>)}</Select></FormField>
 </div></Modal>}
 {edit&&<ExpenseForm initial={edit} categories={cats.data} vehicles={assets.data} staff={staff.data} access={access} onClose={()=>setEdit(null)} onSaved={r=>{setEdit(null);refresh();setDetail(r.id);}}/>}
 {memo&&<Modal open title="지출 메모" onClose={()=>setMemo(null)} footer={<BusinessButton onClick={()=>{setDetail(memo.id);setMemo(null);}}>지출 상세 보기</BusinessButton>}><div className="expense-memo-dialog"><p className="expense-memo-context">{memo.spent_on} · {memo.staff_name||'미지정'}</p><p className="expense-memo-content">{memo.note}</p></div></Modal>}
 {detail&&<ExpenseDetail id={detail} onClose={()=>setDetail(null)} onEdit={r=>{setDetail(null);setEdit(r);}} onChanged={refresh}/>}
 </div>;
}
function CategoryForm({initial,onClose,onSaved}){
 const [f,setF]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function save(e){e.preventDefault();setBusy(true);setError('');try{const p={name:f.name,kind:f.kind,parent_id:f.parent_id,active:f.active,updated_at:f.updated_at};if(f.id)await api.updateExpenseCategory(f.id,p);else await api.createExpenseCategory(p);onSaved();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <Modal open title={`${f.kind==='group'?'대분류':'지출 항목'} ${f.id?'수정':'추가'}`} onClose={busy?undefined:onClose}><form className="expense-form" onSubmit={save}><FormField label="이름"><Input required maxLength={80} value={f.name} onChange={e=>setF({...f,name:e.target.value})}/></FormField>{f.kind!=='group'&&<FormField label="종류"><Select disabled={!!f.id} value={f.kind} onChange={e=>setF({...f,kind:e.target.value})}><option value="expense">일반 비용</option><option value="fuel">유류비 · 운행 주유비 반영</option></Select></FormField>}<label className="expense-toggle"><input type="checkbox" checked={f.active} onChange={e=>setF({...f,active:e.target.checked})}/>사용 중</label><p className="expense-note">기존 지출의 항목명은 바뀌지 않습니다.</p>{error&&<p role="alert">{error}</p>}<div className="business-dialog-actions"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button disabled={busy} type="submit">저장</Button></div></form></Modal>;
}
function ExpenseForm({initial,categories,vehicles,staff,access,onClose,onSaved}){
 const [f,setF]=useState(()=>({spent_on:businessDate(),category_id:'',staff_id:access.staff_id||'',vehicle_id:'',amount_krw:'',payment_method:'company_card',note:'',...initial,request_id:initial.id?undefined:crypto.randomUUID()})),[busy,setBusy]=useState(false),[error,setError]=useState(''),[tripDay,setTripDay]=useState(initial.spent_on||businessDate()),[tripKey,setTripKey]=useState('');
 const field=(k,v)=>setF(p=>({...p,[k]:v}));const category=categories.find(c=>c.id===Number(f.category_id));
 const trips=useQuery({queryKey:['expense-trips',f.vehicle_id,tripDay],queryFn:()=>api.listFleetVehicleTrips(Number(f.vehicle_id),{from:tripDay,to:tripDay}),enabled:!initial.id&&!!category&&!!f.vehicle_id&&!!tripDay});
 const options=expenseTripOptions(trips.data||[],category?.kind);
 const selectedTrip=options.find(t=>`${t.binding_id}:${t.source_started_at}`===tripKey);
 function chooseTrip(key){setTripKey(key);const t=options.find(t=>`${t.binding_id}:${t.source_started_at}`===key);setF(p=>({...p,source_device_id:t?.source_device_id||null,binding_id:t?.binding_id||null,trip_started_at:t?.source_started_at||null,...expenseTripAmount(t,category?.kind)}));}
 function resetTrip(k,v){setTripKey('');setF(p=>({...p,[k]:v,source_device_id:null,binding_id:null,trip_started_at:null}));}
 async function save(e){e.preventDefault();if(busy)return;setBusy(true);setError('');try{const p={request_id:f.request_id,spent_on:f.spent_on,category_id:Number(f.category_id),staff_id:f.staff_id?Number(f.staff_id):null,vehicle_id:f.vehicle_id?Number(f.vehicle_id):null,amount_krw:Number(f.amount_krw),payment_method:f.payment_method,note:f.note,source_device_id:f.source_device_id||null,binding_id:f.binding_id||null,trip_started_at:f.trip_started_at||null,updated_at:initial.updated_at};const r=initial.id?await api.updateExpense(initial.id,p):await api.createExpense(p);onSaved(r);}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <Modal open size="lg" title={initial.id?'지출 수정·재제출':'지출 등록'} onClose={busy?undefined:onClose}><form onSubmit={save} className="expense-form">
 <div className="expense-form-grid"><FormField label="지출일"><Input required type="date" value={f.spent_on} onChange={e=>field('spent_on',e.target.value)}/></FormField><FormField label="사용자"><Select required={!access.manage_team} disabled={!access.manage_reports} value={f.staff_id||''} onChange={e=>field('staff_id',e.target.value)}>{access.manage_team&&<option value="">미지정</option>}{staff.filter(s=>s.active||s.id===initial.staff_id).map(s=><option key={s.id} value={s.id}>{s.name}{s.department?` · ${s.department}`:''}{!s.active?' (사용 중지)':''}</option>)}</Select></FormField></div>
 <FormField label="차량 (선택)"><Select disabled={!!initial.trip_started_at} value={f.vehicle_id||''} onChange={e=>resetTrip('vehicle_id',e.target.value)}><option value="">일반 지출 · 차량 없음</option>{vehicles.filter(v=>v.enabled||v.id===initial.vehicle_id).map(v=><option key={v.id} value={v.id}>{siteVehicleLabel(v)}</option>)}</Select></FormField>
 <FormField label="지출 항목"><Select required value={f.category_id} onChange={e=>initial.trip_started_at?field('category_id',e.target.value):resetTrip('category_id',e.target.value)}><option value="">항목 선택</option>{categories.filter(c=>c.kind!=='group'&&((c.active&&categories.find(g=>g.id===c.parent_id)?.active)||c.id===initial.category_id)&&(!initial.trip_started_at||c.kind===initial.category_kind)).map(c=><option key={c.id} value={c.id}>{categories.find(g=>g.id===c.parent_id)?.name} · {c.name}{!c.active?' (사용 중지)':''}</option>)}</Select></FormField>
 <div className="expense-form-grid"><FormField label="금액 (원)"><Input required type="number" min="1" max="1000000000" step="1" value={f.amount_krw} onChange={e=>field('amount_krw',e.target.value)}/></FormField><FormField label="결제수단"><Select value={f.payment_method} onChange={e=>field('payment_method',e.target.value)}>{Object.entries(paymentMethods).map(([v,l])=><option key={v} value={v}>{l}</option>)}</Select></FormField></div>
 {initial.trip_started_at?<p className="expense-note">{kstDateTime(initial.trip_started_at)} 운행에 연결되어 있습니다.</p>:!initial.id&&category&&f.vehicle_id&&<fieldset className="expense-trip"><legend>운행 연결 (선택)</legend><FormField label="운행일"><Input type="date" value={tripDay} onChange={e=>{setTripDay(e.target.value);chooseTrip('');}}/></FormField>{trips.error?<BusinessError onRetry={trips.refetch}>운행을 조회하지 못했습니다.</BusinessError>:<FormField label="종료된 운행"><Select value={tripKey} disabled={trips.isFetching} onChange={e=>chooseTrip(e.target.value)}><option value="">운행 연결 없이 등록</option>{options.map(t=><option key={`${t.binding_id}:${t.source_started_at}`} value={`${t.binding_id}:${t.source_started_at}`}>{kstDateTime(t.started_at)} → {kstDateTime(t.ended_at)}{category?.kind==='fuel'&&t.annotation?.fuel_cost!=null?` · ${expenseMoney(t.annotation.fuel_cost)}원`:''}</option>)}</Select></FormField>}<p className="expense-note">{category.kind==='fuel'?'기존 주유비가 있으면 같은 금액으로 연결합니다. 승인된 금액만 운행기록부에 반영합니다.':'같은 운행에 여러 지출을 연결할 수 있습니다. 승인된 금액은 지출 합계에만 반영합니다.'}</p>{trips.isFetching&&<p role="status">운행을 불러오는 중…</p>}{!trips.isFetching&&!trips.error&&!options.length&&<p className="expense-note">이 날짜에 연결 가능한 종료 운행이 없습니다.</p>}{category.kind==='fuel'&&selectedTrip?.annotation?.fuel_cost!=null&&<p>기존 주유비: {expenseMoney(selectedTrip.annotation.fuel_cost)}원</p>}</fieldset>}
 <FormField label="메모 (선택)"><Textarea rows={3} maxLength={2000} value={f.note} onChange={e=>field('note',e.target.value)}/></FormField><p className="expense-note">저장 후 영수증을 첨부할 수 있습니다. 수정하면 다시 승인대기 상태가 됩니다.</p>{error&&<p className="business-error" role="alert">{error}</p>}<div className="business-dialog-actions"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button type="submit" disabled={busy||!f.category_id}>{busy?'저장 중…':'저장'}</Button></div>
 </form></Modal>;
}
function ExpenseDetail({id,onClose,onEdit,onChanged}){
 const q=useQuery({queryKey:['expense-detail',id],queryFn:()=>api.expenseDetail(id)}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[status,setStatus]=useState(''),[reason,setReason]=useState(''),[attachmentId,setAttachmentId]=useState(null);
 const busyRef=useRef(false),r=q.data?.expense;
 const native=typeof window!=='undefined'&&!!(window.GpsNative||window.FlutterAppOpenUrl);
 async function action(fn){if(busyRef.current)return;busyRef.current=true;setBusy(true);setError('');try{await fn();setStatus('');setReason('');await q.refetch();onChanged();}catch(e){setError(e.message);await q.refetch();}finally{busyRef.current=false;setBusy(false);}}
 const chooseReview=value=>{setStatus(value);setReason('');setError('');};
 const title=r?`${r.category_name} · ${expenseMoney(r.amount_krw)}원`:`지출 #${id}`;
 return <BusinessDrawer title={title} subtitle={`지출 #${id}${r?` · ${r.spent_on} · ${r.staff_name||'사용자 미지정'}`:''}`} onClose={busy?undefined:onClose}><div className="expense-detail-content" aria-busy={busy}>
 <div className="expense-detail-scroll">{q.error?<BusinessError onRetry={q.refetch}>내역을 불러오지 못했습니다.</BusinessError>:!r?<p role="status">불러오는 중…</p>:<div className="expense-detail-grid">
  <ExpenseInlineAttachments expenseId={id} receipts={q.data.receipts} onOpen={setAttachmentId}/>
  <div className="expense-detail-record">
  {r.review_note&&<section className={`expense-detail-review-note ${r.status==='rejected'?'is-rejected':''}`}><strong>{r.status==='rejected'?'반려 사유':r.status==='cancelled'?'취소 사유':'처리 사유'}</strong><p>{r.review_note}</p></section>}
  <section className="expense-detail-section"><h3>기본 정보</h3><dl className="expense-details">{[['상태',<span className={`business-badge expense-status-${r.status}`}>{expenseStatus[r.status]}</span>],['분류',`${r.group_name} · ${r.category_name}`],['지출일',r.spent_on],['금액',`${expenseMoney(r.amount_krw)}원`],['사용자',r.staff_name||'미지정'],['부서',r.department_name||'미지정'],['차량',r.vehicle_name],['결제수단',paymentMethods[r.payment_method]],['메모',r.note||'—'],['운행 연결',r.trip_started_at?kstDateTime(r.trip_started_at):'없음']].map(([k,v])=><React.Fragment key={k}><dt>{k}</dt><dd>{v}</dd></React.Fragment>)}</dl></section>
  <details className="expense-detail-file-management"><summary>첨부파일 관리 <span>{q.data.receipts.length}</span></summary><section className="expense-receipts" aria-label="첨부파일 관리">
   {q.data.receipts.map(f=><div className="expense-detail-receipt" key={f.id}><button type="button" className="expense-receipt-filename" disabled={busy} onClick={()=>setAttachmentId(f.id)} aria-label={`${f.filename} 미리보기`}><Icon name="file" size={22}/><span>{f.filename}<small>{Math.ceil(f.size_bytes/1024)} KB</small></span></button><div className="expense-receipt-actions"><BusinessButton disabled={busy} onClick={()=>action(async()=>{const blob=await api.downloadExpenseReceipt(id,f.id);await downloadReceipt(blob,f.filename,blob.type.startsWith('image/'));})}>PDF 다운로드</BusinessButton>{!native&&f.mime!=='application/pdf'&&<BusinessButton disabled={busy} onClick={()=>action(async()=>{const blob=await api.downloadExpenseReceipt(id,f.id);await downloadReceipt(blob,f.filename);})}>원본</BusinessButton>}{r.can_edit&&<BusinessButton disabled={busy} onClick={()=>action(()=>api.removeExpenseReceipt(id,f.id))}>제외</BusinessButton>}</div></div>)}
   {!q.data.receipts.length&&<p className="expense-note">첨부된 영수증이 없습니다.</p>}
   {r.can_edit&&<FormField label="영수증 추가 · PDF/JPG/PNG/WebP, 개당 5MB, 최대 5개"><input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" disabled={busy||q.data.receipts.length>=5} onChange={e=>{const file=e.target.files?.[0];e.target.value='';if(file){if(file.size>5*1024*1024)setError('5MB 이하 파일을 선택해 주세요.');else action(()=>api.uploadExpenseReceipt(id,file));}}}/></FormField>}
  </section></details>
  {error&&!status&&<p role="alert" className="business-error">{error}</p>}
  <details className="expense-detail-history"><summary>변경 이력 <span>{q.data.history.length}</span></summary><div className="expense-history">{q.data.history.map(h=><div key={h.id}><strong>{expenseActions[h.action]||h.action}</strong><span>{kstDateTime(h.created_at)} · 계정 #{h.actor_id}</span>{h.after_value?.amount_krw!=null&&<small>{expenseMoney(h.before_value?.amount_krw)} → {expenseMoney(h.after_value.amount_krw)}원</small>}{h.after_value?.review_note&&<small>{h.after_value.review_note}</small>}{h.after_value?.filename&&<small>{h.after_value.filename}</small>}</div>)}{!q.data.history.length&&<p className="expense-note">변경 이력이 없습니다.</p>}</div></details>
  </div>
 </div>}</div>
 <footer className="expense-detail-footer"><div className="expense-detail-review-actions">{!q.error&&r?.can_review&&r.status==='pending'&&<><BusinessButton primary disabled={busy} onClick={()=>chooseReview('approved')}>승인</BusinessButton><BusinessButton disabled={busy} onClick={()=>chooseReview('rejected')}>반려</BusinessButton></>}{!q.error&&r?.can_cancel&&<BusinessButton disabled={busy} onClick={()=>chooseReview('cancelled')}>지출 취소</BusinessButton>}</div><div className="expense-detail-close-actions"><BusinessButton disabled={busy} onClick={onClose}>닫기</BusinessButton>{!q.error&&r?.can_edit&&<BusinessButton icon="edit" disabled={busy} onClick={()=>onEdit(r)}>수정</BusinessButton>}</div></footer>
 {status&&r&&<Modal open title={`지출 ${expenseStatus[status]} 처리`} onClose={busy?undefined:()=>setStatus('')} footer={<div className="expense-review-confirm-actions"><BusinessButton disabled={busy} onClick={()=>setStatus('')}>돌아가기</BusinessButton><BusinessButton primary disabled={busy||status!=='approved'&&!reason.trim()} onClick={()=>action(()=>api.reviewExpense(id,{status,note:reason,updated_at:r.updated_at}))}>{busy?'처리 중…':`${expenseStatus[status]} 처리`}</BusinessButton></div>}><div className="expense-review-confirm"><p>{r.category_name} · {expenseMoney(r.amount_krw)}원</p><FormField label={status==='approved'?'사유 (선택)':'사유 (필수)'}><Textarea aria-label="지출 처리 사유" value={reason} disabled={busy} maxLength={500} rows={3} onChange={e=>setReason(e.target.value)}/></FormField>{error&&<p role="alert" className="business-error">{error}</p>}</div></Modal>}
 {attachmentId!=null&&<ExpenseAttachmentViewer expenseId={id} initialReceiptId={attachmentId} onClose={()=>setAttachmentId(null)}/>}
 </div></BusinessDrawer>;
}
