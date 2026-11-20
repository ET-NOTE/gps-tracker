import React, {useRef, useState} from 'react';
import {useQuery, useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {qk, useStaff} from '../../state';
import {Button, FormField, Input, Modal, Select} from '../ui';
import {BusinessButton, BusinessEmpty, BusinessError, BusinessSection} from './BusinessWorkspace';
import {fleetRoles} from './FleetAccess';

const features = [
  ['manage_vehicles','차량·서류 변경'],['write_reservations','예약 등록·변경·취소'],
  ['review_reservations','예약 승인·반려'],['write_trips','운행기록·지정 규칙 변경'],
  ['write_expenses','지출·영수증 등록 및 수정'],['review_expenses','지출 승인·반려'],
];
const featuresByKey = Object.fromEntries(features);

export default function FleetPermissionGroups() {
  const client=useQueryClient(), staff=useStaff();
  const groups=useQuery({queryKey:['fleet-permission-groups'],queryFn:()=>api.fleetPermissionGroups()});
  const [selected,setSelected]=useState(null), [dialog,setDialog]=useState(''), [draft,setDraft]=useState(null);
  const [target,setTarget]=useState(''), [query,setQuery]=useState(''), [members,setMembers]=useState([]);
  const [error,setError]=useState(''), [busy,setBusy]=useState(false), [message,setMessage]=useState('');
  const lock=useRef(false), items=groups.data||[];
  const current=items.find(g=>g.id===selected)||items[0];
  const users=staff.data||[], memberRows=users.filter(s=>s.permission_group_id===current?.id&&current);
  function open(mode) {
    setDialog(mode);setError('');setMessage('');
    setDraft(mode==='edit'?{...current,permissions:[...current.permissions]}:mode==='copy'?{name:current.name+' 복사',permissions:[...current.permissions]}:{name:'',permissions:[]});
    setTarget(current?String(current.id):'');setMembers([]);setQuery('');
  }
  const close=()=>{if (!lock.current) setDialog('');};
  async function save(e) {
    e.preventDefault();
    if (lock.current) return;
    lock.current=true;setBusy(true);setError('');
    try {
      if (dialog==='assign') {
        const result=await api.assignFleetPermissionGroup({group_id:target?Number(target):null,members});
        setMessage(`사용자 ${result.count}명의 권한 그룹을 변경했습니다.`);
        if(target)setSelected(Number(target));
      } else if (dialog==='delete') {
        await api.deleteFleetPermissionGroup(draft.id,draft.updated_at);
        setSelected(null);setMessage('그룹을 삭제했습니다.');
      } else {
        const body={name:draft.name.trim(),permissions:draft.permissions};
        const saved=draft.id?await api.updateFleetPermissionGroup(draft.id,{...body,updated_at:draft.updated_at}):await api.createFleetPermissionGroup(body);
        setSelected(saved.id);setMessage('권한 그룹을 저장했습니다.');
      }
      setDialog('');
      await Promise.all([client.invalidateQueries({queryKey:['fleet-permission-groups']}),client.invalidateQueries({queryKey:qk.staff()}),
        client.invalidateQueries({queryKey:['fleet-team-audit']})]);
    } catch(cause) {
      setError(cause.message||'권한 그룹을 변경하지 못했습니다.');
      if(cause.status===409||cause.status===404) {
        await Promise.all([groups.refetch(),staff.refetch()]);
      }
    } finally {lock.current=false;setBusy(false);}
  }
  const shown=users.filter(s=>[s.name,s.department,s.position].filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  function toggleMember(user) {
    setMembers(prev=>prev.some(s=>s.id===user.id)?prev.filter(s=>s.id!==user.id):[...prev,{id:user.id,updated_at:user.updated_at}]);
  }
  const assignable=dialog==='assign', deleting=dialog==='delete';
  return <BusinessSection title="맞춤 권한 그룹" action={<BusinessButton primary icon="plus" disabled={groups.isPending||Boolean(groups.error)} onClick={()=>open('create')}>그룹 추가</BusinessButton>}>
    {groups.error?<BusinessError onRetry={groups.refetch}>권한 그룹을 불러오지 못했습니다.</BusinessError>:groups.isPending?<p className="fleet-group-note" role="status">권한 그룹 조회 중…</p>:<>
      <p className="fleet-group-note">그룹에 허용한 작업도 사용자의 기본 역할과 조회 범위 안에서만 가능합니다. 그룹에 배정하면 사용자·조직·회사 설정 관리는 제한됩니다.</p>
      {current?<div className="fleet-group-layout"><div className="fleet-role-list" aria-label="맞춤 그룹 선택">{items.map(g=><button type="button" aria-pressed={current.id===g.id} key={g.id} onClick={()=>setSelected(g.id)}><span>{g.name}</span><small>{g.members}명</small></button>)}</div>
        <div className="fleet-group-content"><header><h3>{current.name}</h3><div className="fleet-group-actions">
          <BusinessButton icon="edit" onClick={()=>open('edit')}>수정</BusinessButton><BusinessButton icon="copy" onClick={()=>open('copy')}>복사</BusinessButton>
          <BusinessButton disabled={current.members>0} title={current.members?'배정된 사용자가 있습니다.':undefined} onClick={()=>{open('delete');setDraft({...current});}}>삭제</BusinessButton>
        </div></header>
        <div className="fleet-group-permissions">{current.permissions.length?current.permissions.map(key=><span key={key}>{featuresByKey[key]||key}</span>):<span>조회 전용</span>}</div>
        <header><h4>배정된 사용자</h4><BusinessButton disabled={staff.isPending||Boolean(staff.error)} onClick={()=>open('assign')}>사용자 배정</BusinessButton></header>
        {staff.error?<BusinessError onRetry={staff.refetch}>사용자를 불러오지 못했습니다.</BusinessError>:staff.isPending?<p>사용자 조회 중…</p>:memberRows.length?<ul className="fleet-group-members">{memberRows.map(s=><li key={s.id}><strong>{s.name}</strong><span>{[s.department,fleetRoles[s.access_role],!s.active?'비활성':''].filter(Boolean).join(' · ')}</span></li>)}</ul>:<p className="fleet-group-note">배정된 사용자가 없습니다.</p>}
        </div></div>:<BusinessEmpty compact title="등록된 맞춤 그룹이 없습니다."/>}
    </>}
    {message&&<p className="fleet-group-note" role="status">{message}</p>}
    {dialog&&<Modal open size={deleting?'sm':'lg'} onClose={busy?undefined:close} title={assignable?'사용자 그룹 배정':deleting?'권한 그룹 삭제':dialog==='edit'?'권한 그룹 수정':dialog==='copy'?'권한 그룹 복사':'권한 그룹 추가'}>
      <form className="fleet-group-form" onSubmit={save}>
        {assignable?<>
          <FormField label="적용할 그룹"><Select value={target} onChange={e=>setTarget(e.target.value)}>
            <option value="">기본 역할로 복원</option>{items.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}
          </Select></FormField>
          {!target&&<p className="fleet-group-warning">그룹 제한을 해제하면 선택한 사용자에게 기본 역할의 모든 권한이 복원됩니다.</p>}
          <FormField label="사용자 검색"><Input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="이름, 부서, 직책"/></FormField>
          <fieldset><legend>배정할 사용자 · {members.length}명 선택</legend><div className="fleet-group-selector">{shown.map(s=>{
            const checked=members.some(item=>item.id===s.id);
            return <label key={s.id}><input type="checkbox" checked={checked} disabled={busy||(!checked&&members.length>=100)} onChange={()=>toggleMember(s)}/>
              <span><strong>{s.name}</strong><small>{[s.department,fleetRoles[s.access_role],items.find(g=>g.id===s.permission_group_id)?.name||'기본 역할',!s.active?'비활성':''].filter(Boolean).join(' · ')}</small></span></label>;
          })}{!shown.length&&<p>조회된 사용자가 없습니다.</p>}</div></fieldset>
        </>:deleting?<p>‘{draft.name}’ 그룹을 삭제할까요?</p>:<>
          <FormField label="그룹명"><Input value={draft.name} required maxLength={60} disabled={busy} onChange={e=>setDraft({...draft,name:e.target.value})}/></FormField>
          <fieldset><legend>허용할 작업</legend><div className="fleet-group-checks">{features.map(([key,label])=><label key={key}><input type="checkbox" checked={draft.permissions.includes(key)} disabled={busy}
            onChange={e=>setDraft({...draft,permissions:e.target.checked?[...draft.permissions,key]:draft.permissions.filter(p=>p!==key)})}/>{label}</label>)}</div></fieldset>
        </>}
        {error&&<BusinessError>{error}</BusinessError>}
        <div className="business-dialog-actions"><Button type="button" variant="ghost" disabled={busy} onClick={close}>취소</Button><Button type="submit" busy={busy} disabled={assignable?!members.length:!deleting&&!draft.name.trim()}>{assignable?'배정 적용':deleting?'그룹 삭제':'그룹 저장'}</Button></div>
      </form>
    </Modal>}
  </BusinessSection>;
}
