import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { Modal } from '../ui';
import { BusinessButton, BusinessError, BusinessEmpty } from './BusinessWorkspace';
import './rental-team.css';
import useCorporatePhone from '../../useCorporatePhone';
import { hideOutsideMockup } from '../../lib/mockupHidden';
import { TeamBranchDirectory, TeamPeopleLedger, TeamRoleWorkspace } from './TeamMockupViews';
import Icon from '../Icon';
import { downloadReport } from '../../lib/downloadReport';

const permissions = {dispatch_read:'배차 조회',service_read:'정비·세차 조회',handover_note:'인수인계 메모 작성'};
const cargoPermissions = {dispatch_read:"지점 배차 조회",fleet_read:"지점 차량 조회",handover_note:"인수인계 메모 작성"};
const names = {staff:'직원',branches:'지점',groups:'권한 그룹'};
// Desktop design: the service permissions placed on the corporate per-menu matrix.
const rentalMenus = [['차량 예약·배차',[['dispatch_read','배차 조회']]],['차량 관리',[['service_read','정비·세차 조회']]],['대여·반납',[['handover_note','인수인계 메모 작성']]]];
const cargoMenus = [['배차관리',[['dispatch_read','지점 배차 조회']]],['차량·기사 관리',[['fleet_read','지점 차량 조회']]],['운송관리',[['handover_note','인수인계 메모 작성']]]];
const impliedPermissions = {handover_note:['dispatch_read']};
export function useRentalTeamConfig(enabled=true) {
  return useQuery({queryKey:['rental-team',authScope()],queryFn:()=>api.rentalTeam('GET','/config'),enabled});
}

function TeamEditor({page,initial,data,onSaved,onClose,cargo}) {
  const [v,setV]=useState(()=>initial||{name:'',email:'',active:true,permissions:[],branch_id:'',group_id:''});
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const field=(key,value)=>setV(s=>({...s,[key]:value}));
  async function save(e){
    e.preventDefault();if(busy)return;
    setBusy(true);setError('');
    try {
      const team=cargo?api.cargoTeam:api.rentalTeam;
      const result=await team(initial?'PUT':'POST','/'+page+(initial?'/'+v.id:''),
        page==='staff'?{name:v.name,email:v.email,branch_id:cargo?String(v.branch_id):Number(v.branch_id),group_id:Number(v.group_id),active:v.active,revision:v.revision}:
        page==='groups'?{name:v.name,permissions:v.permissions,revision:v.revision}:{name:v.name});
      onSaved(result.code);
    }catch(err){setError(err.message);}finally{setBusy(false);}
  }
  return <Modal open title={names[page]+(initial?' 수정':page==='staff'?' 초대':' 추가')} onClose={onClose}><form className="rnt-team-form" onSubmit={save}>
    <label>{names[page]} 이름<input required maxLength={80} value={v.name} onChange={e=>field('name',e.target.value)}/></label>
    {page==='staff'&&<>
      <label>로그인 이메일<input required type="email" maxLength={254} disabled={!!initial} value={v.email} onChange={e=>field('email',e.target.value)}/></label>
      {[['branch_id','지점','branches'],['group_id','권한 그룹','groups']].map(([key,label,source])=><label key={key}>{label}<select aria-label={label} required value={v[key]} onChange={e=>field(key,e.target.value)}>
        <option value="">선택</option>{data[source].map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>)}
      {initial&&<label className="rnt-team-check"><input type="checkbox" checked={v.active} onChange={e=>field('active',e.target.checked)}/>직원 접근 허용</label>}
    </>}
    {page==='groups'&&<fieldset><legend>담당 지점에서 허용할 업무</legend>{Object.entries(cargo?cargoPermissions:permissions).map(([key,label])=><label key={key} className="rnt-team-check">
      <input type="checkbox" checked={v.permissions.includes(key)} onChange={e=>{
        const list=new Set(v.permissions);
        if(e.target.checked){list.add(key);if(key==='handover_note')list.add('dispatch_read');}
        else {list.delete(key);if(key==='dispatch_read')list.delete('handover_note');}
        field('permissions',[...list]);
      }}/>{label}</label>)}</fieldset>}
    {error&&<p role="alert">{error}</p>}<footer><BusinessButton onClick={onClose}>닫기</BusinessButton><button className="business-button is-primary" disabled={busy}>{busy?'저장 중…':page==='staff'&&!initial?'초대 코드 발급':'저장'}</button></footer>
  </form></Modal>;
}
function InviteCode({code,cargo,onClose}) {
  return <Modal open title="직원 초대 코드" onClose={onClose}><div className="rnt-team-form"><p>직원에게 아래 주소와 코드를 전달해 주세요. 직원은 초대받은 이메일로 로그인한 후 7일 안에 한 번 사용할 수 있습니다.</p>
      <label>직원 접속 주소<input readOnly value={window.location.origin+(cargo?'/cargo':'/rentcar')+'?page=staff-desk'}/></label><label>초대 코드<input readOnly value={code} onFocus={e=>e.target.select()}/></label>
      <BusinessButton onClick={onClose}>확인</BusinessButton></div></Modal>;
}
// Desktop design: the user list downloads the rows shown (name, email, branch, group, state) as CSV.
function downloadUsers(rows) {
  const labels=['이름','이메일','지점','권한 그룹','계정 상태'];
  return downloadReport({title:'사용자 목록',filename:'사용자_목록',columns:labels.map((label,key)=>({key,label})),rows:rows.map(r=>[r.name,r.email,r.branch,r.group,r.state])},'csv');
}
export default function RentalTeam({page,onTab,cargo=false}) {
  const team=cargo?api.cargoTeam:api.rentalTeam, key=[cargo?'cargo-team':'rental-team',authScope()];
  const config=useQuery({queryKey:key,queryFn:()=>team('GET','/config')}), qc=useQueryClient();
  const [editor,setEditor]=useState(null),[code,setCode]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const mockup=!useCorporatePhone()&&hideOutsideMockup;
  const [query,setQuery]=useState('');
  const [branchFilter,setBranchFilter]=useState(''),[stateFilter,setStateFilter]=useState(''),[groupFilter,setGroupFilter]=useState('');
  if(config.isPending)return <p role="status">사용자 정보를 불러오는 중…</p>;
  if(config.error)return <BusinessError onRetry={config.refetch}>사용자 정보를 불러오지 못했습니다.</BusinessError>;
  const data=config.data, ready=page!=='staff'||(data.branches.length>0&&data.groups.length>0);
  const find=(table,id)=>data[table].find(i=>i.id===id)?.name||'미지정';
  function saved(value){setEditor(null);setCode(value||'');qc.invalidateQueries({queryKey:key});}
  async function reissue(id){if(busy)return;setBusy(true);setError('');try{saved((await team('POST','/staff/'+id+'/invite')).code);}catch(e){setError(e.message);}finally{setBusy(false);}}
  const dialogs=<>{error&&<p role="alert">{error}</p>}
    {editor&&<TeamEditor cargo={cargo} page={page} initial={editor.initial} data={data} onClose={()=>setEditor(null)} onSaved={saved}/>}
    {code&&<InviteCode code={code} cargo={cargo} onClose={()=>setCode('')}/>}</>;
  if(mockup&&page==='staff'){
    const needle=query.trim().toLowerCase();
    const stateOf=r=>r.active?(r.joined?'active':'pending'):'stopped';
    const rows=data.staff.filter(r=>(!needle||[r.name,r.email].some(v=>String(v||'').toLowerCase().includes(needle)))
      &&(!branchFilter||String(r.branch_id)===branchFilter)&&(!stateFilter||stateOf(r)===stateFilter)&&(!groupFilter||String(r.group_id)===groupFilter)).map(r=>({id:r.id,name:r.name,email:r.email,branch:find('branches',r.branch_id),group:find('groups',r.group_id),
      state:r.active?(r.joined?'사용 중':'초대 대기'):'사용 중지',tone:r.active?(r.joined?'good':'warn'):'',
      actions:<>{r.active&&!r.joined&&<button type="button" className="rt-link" disabled={busy} onClick={()=>reissue(r.id)}>코드 재발급</button>}<button type="button" className="rt-link" aria-label={r.name+' 수정'} onClick={()=>setEditor({initial:r})}>수정</button></>}));
    const select=(label,value,onChange,all,items)=><select className="rt-filter" aria-label={label} value={value} onChange={e=>onChange(e.target.value)}><option value="">{all}</option>{items.map(([id,name])=><option key={id} value={id}>{name}</option>)}</select>;
    const filters=<>{select('지점',branchFilter,setBranchFilter,'전체 지점',data.branches.map(b=>[String(b.id),b.name]))}
      {select('계정 상태',stateFilter,setStateFilter,'전체 상태',[['active','사용 중'],['pending','초대 대기'],['stopped','사용 중지']])}
      {select('권한 그룹',groupFilter,setGroupFilter,'전체 권한 그룹',data.groups.map(g=>[String(g.id),g.name]))}</>;
    const caption=(branchFilter?data.branches.find(b=>String(b.id)===branchFilter)?.name||'선택 지점':'전체 지점')+' · 전체 '+data.staff.length+'명';
    return <div className="rnt-team rt-mockup"><TeamPeopleLedger rows={rows} total={data.staff.length} query={query} onQuery={setQuery} filters={filters} caption={caption}
      action={<><button type="button" className="business-button rt-icon-button" aria-label="사용자 목록 다운로드" title="사용자 목록 다운로드 · CSV" disabled={!rows.length} onClick={()=>downloadUsers(rows).catch(e=>setError(e.message||'다운로드하지 못했습니다.'))}><Icon name="download" size={15}/></button>
        <BusinessButton primary icon="plus" disabled={!ready} onClick={()=>setEditor({initial:null})}>사용자 추가</BusinessButton></>}
      extra={<>{!ready&&<div className="rnt-prerequisites"><p>직원을 초대하려면 소속 지점과 권한 그룹을 먼저 등록해 주세요.</p>{!data.branches.length&&<BusinessButton onClick={()=>onTab('branches')}>지점 등록하기</BusinessButton>} {!data.groups.length&&<BusinessButton onClick={()=>onTab('groups')}>권한 그룹 등록하기</BusinessButton>}</div>}
        {data.notes.length>0&&<section className="rt-card"><header className="rt-card-head"><h3>최근 인수인계 메모</h3></header><ul className="rt-notes">{data.notes.map(n=><li key={n.id}><strong>{n.body}</strong><small>{n.branch} · {n.staff} · {cargo?"운송":"계약"} #{cargo?n.shipment_id:n.contract_id}</small></li>)}</ul></section>}</>}/>{dialogs}</div>;
  }
  if(mockup&&page==='branches'){
    const rows=data.branches.map(b=>{const n=data.staff.filter(x=>x.branch_id===b.id).length;return {id:b.id,name:b.name,members:n+'명',usage:<span className={'rt-badge '+(n?'good':'')}>{n?'사용 중':'소속 없음'}</span>};});
    return <div className="rnt-team rt-mockup"><TeamBranchDirectory branches={rows} onAdd={()=>setEditor({initial:null})}/>{dialogs}</div>;
  }
  if(mockup&&page==='groups'){
    const saveGroup=async ({id,name,permissions,revision})=>{const result=await team(id?'PUT':'POST','/groups'+(id?'/'+id:''),{name,permissions,revision});await qc.invalidateQueries({queryKey:key});return result?.id??id;};
    return <div className="rnt-team rt-mockup"><TeamRoleWorkspace groups={data.groups} memberCount={g=>data.staff.filter(x=>x.group_id===g.id).length} menus={cargo?cargoMenus:rentalMenus} implied={impliedPermissions} save={saveGroup} onMembers={()=>onTab('staff')}/>{dialogs}</div>;
  }
  return <div className="rnt-team">
    <section><header><h2>{names[page]} {data[page].length}{page==='staff'?'명':'개'}</h2><BusinessButton primary icon="plus" disabled={!ready} onClick={()=>setEditor({initial:null})}>{names[page]} {page==='staff'?'초대':'추가'}</BusinessButton></header>
    {!ready&&<div className="rnt-prerequisites"><p>직원을 초대하려면 소속 지점과 권한 그룹을 먼저 등록해 주세요.</p>
      {!data.branches.length&&<BusinessButton onClick={()=>onTab('branches')}>지점 등록하기</BusinessButton>} {!data.groups.length&&<BusinessButton onClick={()=>onTab('groups')}>권한 그룹 등록하기</BusinessButton>}</div>}
    {data[page].length?data[page].map(row=><article key={row.id}><div><strong>{row.name}</strong>
      {page==='staff'&&<><small>{row.email}</small><small>{find('branches',row.branch_id)} · {find('groups',row.group_id)} · {row.active?(row.joined?'사용 중':'초대 대기'):'사용 중지'}</small></>}
      {page==='groups'&&<small>{row.permissions.map(key=>(cargo?cargoPermissions:permissions)[key]).join(' · ')||'허용된 업무 없음'}</small>}
      {page==='branches'&&<small>소속 직원 {data.staff.filter(s=>s.branch_id===row.id).length}명</small>}</div>
      <div>{page==='staff'&&row.active&&!row.joined&&<BusinessButton disabled={busy} onClick={()=>reissue(row.id)}>코드 재발급</BusinessButton>}
      {page!=='branches'&&<BusinessButton onClick={()=>setEditor({initial:row})}>수정</BusinessButton>}</div></article>):<BusinessEmpty title={'등록된 '+names[page]+' 정보가 없습니다.'}/>}</section>
    {page==='staff'&&data.notes.length>0&&<section><header><h2>최근 인수인계 메모</h2></header>{data.notes.map(n=><article key={n.id}><div><strong>{n.body}</strong><small>{n.branch} · {n.staff} · {cargo?"운송":"계약"} #{cargo?n.shipment_id:n.contract_id}</small></div></article>)}</section>}
    {error&&<p role="alert">{error}</p>}
    {editor&&<TeamEditor cargo={cargo} page={page} initial={editor.initial} data={data} onClose={()=>setEditor(null)} onSaved={saved}/>}
    {code&&<InviteCode code={code} cargo={cargo} onClose={()=>setCode('')}/>}
  </div>;
}
