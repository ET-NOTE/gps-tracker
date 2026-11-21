import React,{useState} from 'react';
import FleetStaffImport from './FleetStaffImport';
import {DirectoryGroups} from './DirectoryLayout';
import FleetPermissionGroups from './FleetPermissionGroups';
import {fleetAssetLabel} from '../../lib/fleetAssets';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {useStaff,qk} from '../../state';
import {Modal,FormField,Input,Select,Button} from '../ui';
import {confirmDialog} from '../Dialog';
import {BusinessError} from './BusinessWorkspace';
import {useFleetAccess,useFleetOrganization,fleetRoles} from './FleetAccess';
import {useFleetAssets} from './FleetAssets';
import {kstDateTime} from '../../lib/businessExport';
import Icon from '../Icon';
import useCorporatePhone from '../../useCorporatePhone';
import './fleet-people-cartax.css';
import './fleet-administration.css';

export default function FleetPeople({activeTab,onTab,hideNavigation=false}={}){
 const access=useFleetAccess(),qc=useQueryClient(),staff=useStaff(),org=useFleetOrganization(),vehicles=useFleetAssets();
 const mobile=useCorporatePhone();
 const [importing,setImporting]=useState(false),[internalTab,setInternalTab]=useState('users'),[edit,setEdit]=useState(null),[item,setItem]=useState(null),[invite,setInvite]=useState(null),[query,setQuery]=useState(''),[department,setDepartment]=useState(''),[status,setStatus]=useState('all'),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [roleFilter,setRoleFilter]=useState('');
 const tab=activeTab??internalTab;
 const setTab=value=>{setInternalTab(value);onTab?.(value);};
 const invites=useQuery({queryKey:['fleet-invites'],queryFn:()=>api.fleetInvites(),enabled:access.manage_team});
 const audit=useQuery({queryKey:['fleet-team-audit'],queryFn:()=>api.fleetTeamAudit(),enabled:access.manage_team&&tab==='audit'});
 async function refresh(){await Promise.all([qc.invalidateQueries({queryKey:qk.staff()}),qc.invalidateQueries({queryKey:['fleet-organization']}),qc.invalidateQueries({queryKey:['fleet-invites']}),qc.invalidateQueries({queryKey:['fleet-team-audit']})]);}
 async function run(fn){if(busy)return;setBusy(true);setError('');try{await fn();await refresh();}catch(e){setError(e.message||'처리하지 못했습니다.');}finally{setBusy(false);}}
 const editable=s=>access.manage_team&&(access.role==='owner'||s.access_role!=='admin');
 const ready=!staff.error&&!staff.isPending;
 const searched=(ready?staff.data||[]:[]).filter(s=>!roleFilter || (s.access_role||'member')===roleFilter).filter(s=>[s.name,s.department,s.position,s.phone,s.account_email].some(v=>String(v||'').toLowerCase().includes(query.trim().toLowerCase())));
 const inDepartment=(s,id)=>!id||(id==='unassigned'?!s.department_id:String(s.department_id)===String(id));
 const matches=searched.filter(s=>inDepartment(s,department));
 const rows=matches.filter(s=>status==='all'||Boolean(s.active)===(status==='active'));
 const groupScope=searched.filter(s=>status==='all'||Boolean(s.active)===(status==='active'));
 const departmentItems=[
  {id:'',label:'전체 보기',count:ready?searched.length:null},
  ...[...(org.data||[]).filter(i=>i.kind==='department').map(i=>({id:String(i.id),label:`${i.name}${!i.active?' (사용 중지)':''}`})),{id:'unassigned',label:'부서 미지정'}]
   .map(i=>({...i,count:ready?groupScope.filter(s=>inDepartment(s,i.id)).length:null})),
 ];
 const roleSelect=<select className="fleet-people-role-filter" aria-label="사용자 권한 필터" value={roleFilter} onChange={e=>setRoleFilter(e.target.value)}><option value="">전체 권한</option>{['admin','department_manager','member'].map(key=><option key={key} value={key}>{fleetRoles[key]}</option>)}</select>;
 const pendingInvites=(invites.data||[]).filter(i=>!i.accepted_at&&!i.revoked_at&&Date.parse(i.expires_at)>Date.now());
 const personActions=s=><div className="fleet-row-actions"><button className="business-button" disabled={busy} onClick={()=>setEdit(s)}>수정</button>{s.active&&!s.account_id&&<button className="business-button" disabled={busy} onClick={()=>run(async()=>setInvite({...await api.inviteFleetStaff(s.id),name:s.name}))}>초대</button>}{s.account_id&&<button className="business-button" disabled={busy} onClick={async()=>{if(await confirmDialog({title:'계정 연결 해제',body:`${s.name}님의 회사 접근을 해제할까요? 운행 기록은 유지됩니다.`}))run(()=>api.unlinkFleetStaff(s.id));}}>연결 해제</button>}<button className="business-button" disabled={busy} onClick={async()=>{if(await confirmDialog({title:s.active?'사용자 비활성화':'사용자 활성화',body:s.active?'회사 접근과 신규 운행 배정을 중지합니다. 과거 기록은 유지됩니다.':'사용자를 다시 활성화할까요? 연결된 계정의 회사 접근도 복원됩니다.'}))run(()=>api.updateStaff(s.id,{active:!s.active,updated_at:s.updated_at}));}}>{s.active?'비활성화':'활성화'}</button></div>;
 const invitePanel=access.manage_team&&<details className="fleet-people-invites"><summary>초대 대기 ({invites.error||invites.isPending?'—':pendingInvites.length})</summary><p className="fleet-team-note">사용자를 등록한 뒤 초대 코드를 전달하세요. 직원이 자기 계정으로 수락하면 회사에 연결됩니다.</p>{invites.error?<BusinessError onRetry={invites.refetch}>초대 상태를 불러오지 못했습니다.</BusinessError>:invites.isPending?<p className="fleet-team-empty">초대 상태를 불러오는 중…</p>:pendingInvites.length?pendingInvites.map(i=><div className="fleet-pending-invite" key={i.id}><span>{i.name} <small>{kstDateTime(i.expires_at)} 만료</small></span><button className="business-button" disabled={busy} onClick={()=>run(()=>api.revokeFleetInvite(i.id))}>초대 취소</button></div>):<p className="fleet-team-empty">대기 중인 초대가 없습니다.</p>}</details>;
 return <div className="fleet-team fleet-people-cartax">
  {!hideNavigation&&<div className="business-switch"><button className="business-switch-item" aria-pressed={tab==='users'} onClick={()=>setTab('users')}>사용자 목록</button><button className="business-switch-item" aria-pressed={tab==='organization'} onClick={()=>setTab('organization')}>부서·직책</button><button className="business-switch-item" aria-pressed={tab==='permissions'} onClick={()=>setTab('permissions')}>권한 관리</button>{access.manage_team&&<button className="business-switch-item" aria-pressed={tab==='audit'} onClick={()=>setTab('audit')}>변경 이력</button>}</div>}
  {error&&<BusinessError>{error}</BusinessError>}
  {tab==='users'&&<>
   <div className="fleet-record-toolbar fleet-people-filters" aria-label="사용자 조회 조건">
    <div className="fleet-record-query">
     <label className="fleet-inline-search"><Icon name="search" size={15}/><input type="search" aria-label="사용자 검색" placeholder="이름, 이메일 검색" value={query} onChange={e=>setQuery(e.target.value)}/></label>
     <select className="fleet-people-department-filter" aria-label="사용자 부서" value={department} onChange={e=>setDepartment(e.target.value)}>{departmentItems.map(i=><option key={i.id} value={i.id}>{i.id?i.label:'전체 부서'}</option>)}</select>
     <select className="fleet-people-status-filter" aria-label="사용자 상태" value={status} onChange={e=>setStatus(e.target.value)}>{[['all','전체 상태'],['active','활성'],['inactive','비활성']].map(([k,v])=><option key={k} value={k}>{v}</option>)}</select>{roleSelect}
    </div>
    {access.manage_team&&<div className="fleet-record-actions"><button type="button" className="business-button" onClick={()=>setImporting(true)}>CSV 일괄 등록</button><button type="button" className="business-button is-primary" onClick={()=>setEdit({})}><Icon name="plus" size={15}/>사용자 등록</button></div>}
   </div>

   <section className="fleet-people-ledger" aria-label="사용자 목록">
    <header className="fleet-member-recordhead"><div><h2>사용자 {ready?rows.length:'—'}명</h2>
     <p className="fleet-people-count">{department ? departmentItems.find(item=>item.id===department)?.label||'선택 부서' : '전체 부서'} · 전체 {ready?(staff.data?.length||0)+'명':'—'}</p></div>
     {access.manage_team&&<button type="button" className="business-button" aria-label="부서·직책 관리" onClick={()=>setTab('organization')}>부서·직책 관리</button>}</header>
    {mobile?<>
    {staff.error?<BusinessError onRetry={staff.refetch}/>:staff.isPending?<p className="fleet-team-empty">사용자를 불러오는 중…</p>:rows.length?
      <div className="fleet-mobile-people-scroll" role="region" aria-label="사용자 목록 · 좌우 스크롤" tabIndex={0}>
       <div className="fleet-people-columns" aria-hidden="true"><span>사용자</span><span>부서 · 직책</span><span>권한</span><span>상태</span></div>
       <ul className="mobile-fleet-rows">{rows.map(s=><li key={s.id}><details className="mobile-person">
        <summary className="mobile-fleet-row" aria-label={`${s.name} 상세`}>
          <span className="mobile-fleet-row-main">
            <strong className="mobile-fleet-row-title">{s.name}</strong>
            {s.account_email&&<span className="mobile-fleet-row-copy">{s.account_email}</span>}
          </span>
          <span>{[s.department,s.position].filter(Boolean).join(' / ')||'미지정'}</span>
          <span>{fleetRoles[s.access_role]||'일반 사용자'}</span>
          <span className={`mobile-fleet-pill ${s.active?'is-primary':''}`}>{s.active?'활성':'비활성'}</span>
        </summary>
        <div className="mobile-person-details">
          <dl>
            {s.role&&<div><dt>담당 업무</dt><dd>{s.role}</dd></div>}
            <div><dt>연락처</dt><dd>{s.phone||'미등록'}</dd></div>
            <div><dt>권한</dt><dd>{fleetRoles[s.access_role]||'일반 사용자'}{s.permission_group_id!=null&&' · 맞춤 그룹 적용'}</dd></div>
            <div><dt>운행 가능 차량</dt><dd><PersonVehicles person={s} vehicles={vehicles}/></dd></div>
            <div><dt>계정 연결</dt><dd>{s.account_id?(s.account_email||'연결됨'):'미연결'}</dd></div>
            <div><dt>등록일</dt><dd>{kstDateTime(s.created_at).slice(0,10)}</dd></div>
            <div><dt>상태</dt><dd>{s.active?'활성':'비활성'}</dd></div>
          </dl>
          {editable(s)&&personActions(s)}
        </div>
      </details></li>)}</ul></div>:<p className="fleet-team-empty">{staff.data?.length?'조건에 맞는 사용자가 없습니다.':'등록된 사용자가 없습니다.'}</p>}
    </>:<>
   {staff.error?<BusinessError onRetry={staff.refetch}/>:staff.isPending?<p className="fleet-team-empty">사용자를 불러오는 중…</p>:<div className="fleet-asset-table-wrap" tabIndex={0} role="region" aria-label="사용자 목록 표"><table className="fleet-asset-table fleet-people-table"><thead><tr>{['이름','부서·직책','연락처','권한','운행 가능 차량','계정 연결','등록일','상태','관리'].map(v=><th scope="col" key={v}>{v}</th>)}</tr></thead><tbody>{rows.map(s=><tr key={s.id}><td>{editable(s)?<button type="button" className="fleet-people-name" disabled={busy} onClick={()=>setEdit(s)}>{s.name}</button>:<strong>{s.name}</strong>}{s.role&&<small>{s.role}</small>}</td><td>{s.department||'—'}<small>{s.position||'—'}</small></td><td>{s.phone||'—'}</td><td>{fleetRoles[s.access_role]||'일반 사용자'}{s.permission_group_id!=null&&<small>맞춤 그룹 적용</small>}</td><td><PersonVehicles person={s} vehicles={vehicles}/></td><td>{s.account_id?<><span className="business-badge good">연결됨</span>{s.account_email&&<small className="fleet-people-account-email" title={s.account_email}>{s.account_email}</small>}</>:<span className="business-note">미연결</span>}</td><td>{kstDateTime(s.created_at).slice(0,10)}</td><td><span className={`business-badge ${s.active?'good':''}`}>{s.active?'활성':'비활성'}</span></td><td>{editable(s)&&<details className="fleet-people-row-menu"><summary aria-label={`${s.name} 관리`}>관리</summary>{personActions(s)}</details>}</td></tr>)}</tbody></table>{!rows.length&&<p className="fleet-team-empty">{staff.data?.length?'조건에 맞는 사용자가 없습니다.':'등록된 사용자가 없습니다.'}</p>}</div>}
    </>}
   </section>
   <details className="fleet-people-invites fleet-people-scopes">
    <summary>부서별 사용자 현황</summary>
    <div className="fleet-people-status-tabs" aria-label="사용자 상태">{[['all','전체'],['active','활성'],['inactive','비활성']].map(([key,label])=><button type="button" className="fleet-people-status-tab" key={key} aria-pressed={status===key} onClick={()=>setStatus(key)}>{label} ({ready?matches.filter(s=>key==='all'||Boolean(s.active)===(key==='active')).length:'—'})</button>)}</div>
    <DirectoryGroups title="부서" aria-label="사용자 부서" items={departmentItems} value={status==='inactive'&&!department?'__inactive':department} onChange={value=>{setDepartment(String(value));if(!value)setStatus('all');}} footer={<>{org.error?<BusinessError onRetry={org.refetch}>부서 목록을 불러오지 못했습니다.</BusinessError>:org.isPending&&<p role="status">부서 불러오는 중…</p>}<button type="button" className="fleet-directory-footer-action" aria-pressed={status==='inactive'&&!department} onClick={()=>{setDepartment('');setStatus('inactive');}}><span>비활성 사용자</span><span className="fleet-directory-group-count">{ready?searched.filter(s=>!s.active).length:'—'}</span></button></>}/>
   </details>
   {invitePanel}
  </>}
  {tab==='organization'&&(org.error?<BusinessError onRetry={org.refetch}/>:org.isPending?<p className="fleet-team-empty">부서·직책을 불러오는 중…</p>:<div className="fleet-org-grid">{[['department','부서'],['position','직책']].map(([kind,label])=>{const items=(org.data||[]).filter(i=>i.kind===kind);return <section className="fleet-org-section" key={kind} aria-label={label+' 관리'}><header><h3>{label}<span>{items.length}</span></h3>{access.manage_team&&<button type="button" className="business-button" aria-label={label+' 추가'} onClick={()=>setItem({kind,name:'',active:true})}>+ 추가</button>}</header><table className="fleet-org-table" aria-label={label+' 목록'}><thead><tr><th scope="col">{label}명</th><th scope="col">상태</th>{access.manage_team&&<th scope="col">관리</th>}</tr></thead><tbody>{items.map(i=><tr key={i.id}><td>{i.name}</td><td><span className={'business-badge '+(i.active?'good':'')}>{i.active?'사용 중':'사용 중지'}</span></td>{access.manage_team&&<td><button type="button" className="business-button" aria-label={i.name+' '+label+' 수정'} onClick={()=>setItem(i)}>수정</button></td>}</tr>)}</tbody></table>{!items.length&&<p className="fleet-team-empty">등록된 {label}{kind==='position'?'이':'가'} 없습니다.</p>}</section>;})}</div>)}
  {tab==='permissions'&&<>
    <RoleAccess access={access} onMembers={role=>{setRoleFilter(role);setDepartment('');setStatus('all');setQuery('');setTab('users');}}/>
    {access.role==='owner'&&access.billing&&<FleetPermissionGroups/>}
  </>}
  {tab==='audit'&&access.manage_team&&<section className="fleet-people-ledger" aria-label="변경 이력">{audit.error?<BusinessError onRetry={audit.refetch}/>:audit.isPending?<p className="fleet-team-empty">불러오는 중…</p>:<div className="fleet-asset-table-wrap" tabIndex={0} role="region" aria-label="변경 이력 표"><table className="fleet-asset-table"><thead><tr><th>시각</th><th>작업</th><th>작업자 계정</th><th>대상</th></tr></thead><tbody>{audit.data?.map(a=><tr key={a.id}><td>{kstDateTime(a.created_at)}</td><td>{{permission_group:'권한 그룹 변경',permission_assignment:'권한 그룹 배정',site:'지점 변경',site_group:'지점 그룹 변경',staff:'사용자 변경',staff_import:'사용자 일괄 등록',organization:'부서·직책 변경',invite_create:'초대 생성',invite_revoke:'초대 취소',invite_accept:'초대 수락',account_unlink:'계정 연결 해제',delegated_request:'직원 작업'}[a.action]||a.action}{a.action==='delegated_request'&&<small>{a.after_value?.method} · {a.after_value?.status}</small>}</td><td>{a.actor_id??'탈퇴 계정'}</td><td>{a.target_id||'—'}</td></tr>)}</tbody></table>{!audit.data?.length&&<p className="fleet-team-empty">변경 이력이 없습니다.</p>}</div>}</section>}
  {importing&&<FleetStaffImport onClose={()=>setImporting(false)} onSaved={refresh}/>}
  {edit&&<PersonForm person={edit} org={org.data||[]} vehicles={vehicles.data||[]} onClose={()=>setEdit(null)} onSaved={()=>{setEdit(null);refresh();}}/>}
  {item&&<OrgForm item={item} onClose={()=>setItem(null)} onSaved={()=>{setItem(null);refresh();qc.invalidateQueries({queryKey:['business','corporate','vehicles']});}}/>}
  {invite&&<InviteCode value={invite} onClose={()=>setInvite(null)}/>}
 </div>;
}
const roleCapabilities = [
 ['manage_team','사용자·조직 관리',['owner','admin']],
 ['manage_vehicles','차량 등록·수정',['owner','admin']],
 ['manage_reports','운행기록 지정·보정',['owner','admin','department_manager']],
 ['write_reservations','예약 등록·변경·취소',['owner','admin','department_manager','member']],
 ['review_reservations','예약 승인·반려',['owner','admin','department_manager']],
 ['write_trips','기본 역할 범위 내 운행기록 수정',['owner','admin','department_manager','member']],
 ['write_expenses','지출·영수증 등록 및 수정',['owner','admin','department_manager','member']],
 ['review_expenses','지출 승인·반려',['owner','admin','department_manager']],
 ['billing','이용권 결제',['owner']],
];
function RoleAccess({access,onMembers}) {
 const [selected,setSelected]=useState(access.role);
 const own=selected===access.role;
 return <section className="fleet-role-panel" aria-label="역할별 권한">
  <div className="fleet-role-list" aria-label="역할 선택">
   {Object.entries(fleetRoles).map(([role,name])=><button key={role} type="button" aria-pressed={selected===role} onClick={()=>setSelected(role)}>
    <span>{name}</span>{role===access.role&&<small>{access.group_id!=null?'맞춤 그룹 적용':'내 권한'}</small>}
   </button>)}
  </div>
  <div className="fleet-role-detail"><header><h3>{fleetRoles[selected]}</h3>
   {selected!=='owner'&&access.manage_team&&<button type="button" className="business-button" onClick={()=>onMembers(selected)}>사용자 보기</button>}
  </header><dl>{roleCapabilities.map(([key,label,roles])=>{
    const allowed=own&&typeof access[key]==='boolean'?access[key]:roles.includes(selected);
    return <div key={key}><dt>{label}</dt><dd className={allowed?'allowed':''}>{allowed?'사용 가능':'권한 없음'}</dd></div>;
  })}</dl></div>
 </section>;
}

function PersonVehicles({person,vehicles}){
 if(person.all_vehicles)return '전체 차량';
 if(vehicles.error)return <span className="business-note">차량 조회 실패</span>;
 if(vehicles.isPending)return <span className="business-note">조회 중…</span>;
 const assigned=(vehicles.data||[]).filter(v=>person.vehicle_ids?.includes(v.id)||v.manager_staff_id===person.id);
 if(!assigned.length)return '미지정';
 if(assigned.length===1){
  const vehicle=assigned[0],name=vehicle.name?.trim(),plate=vehicle.license_plate?.trim();
  if(!plate)return fleetAssetLabel(vehicle);
  return <span className="fleet-people-assigned-vehicle"><span>{name||plate}</span>{name&&name!==plate&&<small>{plate}</small>}</span>;
 }
 return <details className="fleet-people-vehicle-list"><summary aria-label={person.name+' 운행 가능 차량 '+assigned.length+'대'}>{assigned.length}대 배정</summary><ul>{assigned.map(v=><li key={v.id}>{fleetAssetLabel(v)}</li>)}</ul></details>;
}
function PersonForm({person,org,vehicles,onClose,onSaved}){
 const access=useFleetAccess();const [f,setF]=useState({name:person.name||'',role:person.role||'',phone:person.phone||'',department_id:person.department_id||'',position_id:person.position_id||'',access_role:person.access_role||'member',all_vehicles:person.all_vehicles??false,vehicle_ids:person.vehicle_ids||[],active:person.active??true}),[busy,setBusy]=useState(false),[error,setError]=useState('');const field=(k,v)=>setF(p=>({...p,[k]:v}));
 async function submit(e){e.preventDefault();setBusy(true);setError('');try{const body={...f,department_id:Number(f.department_id)||null,position_id:Number(f.position_id)||null,...(person.id?{updated_at:person.updated_at}:{})};if(person.id)await api.updateStaff(person.id,body);else await api.createStaff(body);onSaved();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <Modal open size="lg" title={person.id?'사용자 수정':'사용자 등록'} onClose={busy?undefined:onClose}><form onSubmit={submit} className="fleet-team-form fleet-person-form"><section className="fleet-person-form-section" aria-label="기본 정보"><h3>기본 정보</h3><div className="fleet-asset-fields"><FormField label="이름" required><Input required maxLength={64} value={f.name} onChange={e=>field('name',e.target.value)}/></FormField><FormField label="연락처"><Input maxLength={50} value={f.phone} onChange={e=>field('phone',e.target.value)}/></FormField>{[['department','부서','department_id'],['position','직책','position_id']].map(([kind,label,key])=><FormField key={key} label={label}><Select required={key==='department_id'&&f.access_role==='department_manager'} value={f[key]} onChange={e=>field(key,e.target.value)}><option value="">미지정</option>{org.filter(i=>i.kind===kind&&(i.active||i.id===person[key])).map(i=><option key={i.id} value={i.id}>{i.name}{!i.active?' (사용 중지)':''}</option>)}</Select></FormField>)}</div></section><section className="fleet-person-form-section" aria-label="상세 정보"><h3>상세 정보</h3><div className="fleet-asset-fields"><FormField label="담당 업무"><Input maxLength={100} value={f.role} onChange={e=>field('role',e.target.value)} placeholder="예: 영업·배차"/></FormField><FormField label="접근 권한"><Select value={f.access_role} onChange={e=>field('access_role',e.target.value)}>{Object.entries(fleetRoles).filter(([k])=>k!=='owner'&&(k!=='admin'||access.role==='owner')).map(([k,v])=><option key={k} value={k}>{v}</option>)}</Select></FormField></div><p className="business-note">{f.access_role==='admin'?'회사 차량·사용자·설정을 관리합니다. 관리자 지정과 이용권 결제는 소유자가 담당합니다.':f.access_role==='department_manager'?'소속 부서의 차량·사용자를 조회하고 예약·운행기록을 관리합니다.':'운행 가능 차량을 조회하고 본인의 예약·운행기록을 작성합니다.'}</p><fieldset><legend>운행 가능 차량</legend><label className="fleet-asset-toggle"><input type="checkbox" checked={f.all_vehicles} onChange={e=>field('all_vehicles',e.target.checked)}/>전체 차량</label>{!f.all_vehicles&&<div className="fleet-connection-list">{vehicles.map(v=><label key={v.id}><input type="checkbox" checked={f.vehicle_ids.includes(v.id)} onChange={e=>field('vehicle_ids',e.target.checked?[...f.vehicle_ids,v.id]:f.vehicle_ids.filter(id=>id!==v.id))}/>{fleetAssetLabel(v)}</label>)}{!vehicles.length&&<p>차량을 먼저 등록해 주세요.</p>}</div>}<small>차량 담당자로 지정된 차량도 운행할 수 있습니다. 부서 관리자의 조회 범위는 소속 부서입니다.</small></fieldset></section>{error&&<p role="alert" className="business-error">{error}</p>}<div className="business-dialog-actions"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>취소</Button><Button type="submit" disabled={busy}>{busy?'저장 중…':'저장'}</Button></div></form></Modal>;
}
function OrgForm({item,onClose,onSaved}){const [name,setName]=useState(item.name),[active,setActive]=useState(item.active),[busy,setBusy]=useState(false),[error,setError]=useState('');async function save(e){e.preventDefault();if(busy)return;setBusy(true);setError('');try{const p={kind:item.kind,name,active,updated_at:item.updated_at};if(item.id)await api.updateFleetOrgItem(item.id,p);else await api.createFleetOrgItem(p);onSaved();}catch(e){setError(e.message);}finally{setBusy(false);}}return <Modal open title={`${item.kind==='department'?'부서':'직책'} ${item.id?'수정':'추가'}`} onClose={busy?undefined:onClose}><form onSubmit={save} className="fleet-team-form fleet-org-form"><FormField label="이름"><Input required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></FormField><label className="fleet-asset-toggle"><input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)}/>사용 중</label><p className="business-note">사용 중지 후에는 새로 선택할 수 없습니다. 기존 배정과 운행 기록은 유지됩니다.</p>{error&&<p role="alert">{error}</p>}<div className="business-dialog-actions"><Button variant="ghost" type="button" onClick={onClose} disabled={busy}>취소</Button><Button type="submit" disabled={busy}>저장</Button></div></form></Modal>;}
function InviteCode({value,onClose}){const [copied,setCopied]=useState(false);return <Modal open title={`${value.name}님 초대 코드`} onClose={onClose}><div className="fleet-team-form"><FormField label="초대 코드"><Input readOnly value={value.code} onFocus={e=>e.target.select()}/></FormField><p>직원에게 코드를 전달해 주세요. 직원이 로그인 후 ‘내정보 → 회사 초대 연결’에서 입력하면 됩니다.</p><p className="business-note">{kstDateTime(value.expires_at)}까지 한 번 사용 가능 · 이 창을 닫으면 코드를 다시 조회할 수 없습니다.</p><div className="business-dialog-actions"><Button variant="ghost" onClick={onClose}>닫기</Button><Button onClick={async()=>{try{await navigator.clipboard.writeText(value.code);setCopied(true);}catch{setCopied(false);}}}>{copied?'복사됨':'코드 복사'}</Button></div></div></Modal>;}
