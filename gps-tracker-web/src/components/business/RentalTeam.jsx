import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { Modal } from '../ui';
import { BusinessButton, BusinessError, BusinessEmpty } from './BusinessWorkspace';
import './rental-team.css';

const permissions = {dispatch_read:'배차 조회',service_read:'정비·세차 조회',handover_note:'인수인계 메모 작성'};
const names = {staff:'직원',branches:'지점',groups:'권한 그룹'};
export function useRentalTeamConfig(enabled=true) {
  return useQuery({queryKey:['rental-team',authScope()],queryFn:()=>api.rentalTeam('GET','/config'),enabled});
}

function TeamEditor({page,initial,data,onSaved,onClose}) {
  const [v,setV]=useState(()=>initial||{name:'',email:'',active:true,permissions:[],branch_id:'',group_id:''});
  const [error,setError]=useState(''),[busy,setBusy]=useState(false);
  const field=(key,value)=>setV(s=>({...s,[key]:value}));
  async function save(e){
    e.preventDefault();if(busy)return;
    setBusy(true);setError('');
    try {
      const result=await api.rentalTeam(initial?'PUT':'POST','/'+page+(initial?'/'+v.id:''),
        page==='staff'?{name:v.name,email:v.email,branch_id:Number(v.branch_id),group_id:Number(v.group_id),active:v.active,revision:v.revision}:
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
    {page==='groups'&&<fieldset><legend>담당 지점에서 허용할 업무</legend>{Object.entries(permissions).map(([key,label])=><label key={key} className="rnt-team-check">
      <input type="checkbox" checked={v.permissions.includes(key)} onChange={e=>{
        const list=new Set(v.permissions);
        if(e.target.checked){list.add(key);if(key==='handover_note')list.add('dispatch_read');}
        else {list.delete(key);if(key==='dispatch_read')list.delete('handover_note');}
        field('permissions',[...list]);
      }}/>{label}</label>)}</fieldset>}
    {error&&<p role="alert">{error}</p>}<footer><BusinessButton onClick={onClose}>닫기</BusinessButton><button className="business-button is-primary" disabled={busy}>{busy?'저장 중…':page==='staff'&&!initial?'초대 코드 발급':'저장'}</button></footer>
  </form></Modal>;
}
export default function RentalTeam({page,onTab}) {
  const config=useRentalTeamConfig(), qc=useQueryClient();
  const [editor,setEditor]=useState(null),[code,setCode]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  if(config.isPending)return <p role="status">사용자 정보를 불러오는 중…</p>;
  if(config.error)return <BusinessError onRetry={config.refetch}>사용자 정보를 불러오지 못했습니다.</BusinessError>;
  const data=config.data, ready=page!=='staff'||(data.branches.length>0&&data.groups.length>0);
  const find=(table,id)=>data[table].find(i=>i.id===id)?.name||'미지정';
  function saved(value){setEditor(null);setCode(value||'');qc.invalidateQueries({queryKey:['rental-team',authScope()]});}
  async function reissue(id){if(busy)return;setBusy(true);setError('');try{saved((await api.rentalTeam('POST','/staff/'+id+'/invite')).code);}catch(e){setError(e.message);}finally{setBusy(false);}}
  return <div className="rnt-team">
    <section><header><h2>{names[page]} {data[page].length}{page==='staff'?'명':'개'}</h2><BusinessButton primary icon="plus" disabled={!ready} onClick={()=>setEditor({initial:null})}>{names[page]} {page==='staff'?'초대':'추가'}</BusinessButton></header>
    {!ready&&<div className="rnt-prerequisites"><p>직원을 초대하려면 소속 지점과 권한 그룹을 먼저 등록해 주세요.</p>
      {!data.branches.length&&<BusinessButton onClick={()=>onTab('branches')}>지점 등록하기</BusinessButton>} {!data.groups.length&&<BusinessButton onClick={()=>onTab('groups')}>권한 그룹 등록하기</BusinessButton>}</div>}
    {data[page].length?data[page].map(row=><article key={row.id}><div><strong>{row.name}</strong>
      {page==='staff'&&<><small>{row.email}</small><small>{find('branches',row.branch_id)} · {find('groups',row.group_id)} · {row.active?(row.joined?'사용 중':'초대 대기'):'사용 중지'}</small></>}
      {page==='groups'&&<small>{row.permissions.map(key=>permissions[key]).join(' · ')||'허용된 업무 없음'}</small>}
      {page==='branches'&&<small>소속 직원 {data.staff.filter(s=>s.branch_id===row.id).length}명</small>}</div>
      <div>{page==='staff'&&row.active&&!row.joined&&<BusinessButton disabled={busy} onClick={()=>reissue(row.id)}>코드 재발급</BusinessButton>}
      {page!=='branches'&&<BusinessButton onClick={()=>setEditor({initial:row})}>수정</BusinessButton>}</div></article>):<BusinessEmpty title={'등록된 '+names[page]+' 정보가 없습니다.'}/>}</section>
    {page==='staff'&&data.notes.length>0&&<section><header><h2>최근 인수인계 메모</h2></header>{data.notes.map(n=><article key={n.id}><div><strong>{n.body}</strong><small>{n.branch} · {n.staff} · 계약 #{n.contract_id}</small></div></article>)}</section>}
    {error&&<p role="alert">{error}</p>}
    {editor&&<TeamEditor page={page} initial={editor.initial} data={data} onClose={()=>setEditor(null)} onSaved={saved}/>}
    {code&&<Modal open title="직원 초대 코드" onClose={()=>setCode('')}><div className="rnt-team-form"><p>직원에게 아래 주소와 코드를 전달해 주세요. 직원은 초대받은 이메일로 로그인한 후 7일 안에 한 번 사용할 수 있습니다.</p>
      <label>직원 접속 주소<input readOnly value={window.location.origin+'/rentcar?page=staff-desk'}/></label><label>초대 코드<input readOnly value={code} onFocus={e=>e.target.select()}/></label>
      <BusinessButton onClick={()=>setCode('')}>확인</BusinessButton></div></Modal>}
  </div>;
}
