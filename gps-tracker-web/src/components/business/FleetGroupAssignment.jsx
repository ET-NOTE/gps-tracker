import {useRef, useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {qk} from '../../state';
import {Button, FormField, Input, Modal, Select} from '../ui';
import {BusinessError} from './BusinessWorkspace';
import {fleetRoles} from './FleetAccess';

export const maxGroupMembers = 100;
export function canAssignFleetMember(row) {
  return Number.isSafeInteger(row.id) && row.id > 0 && Number.isFinite(Date.parse(row.updated_at));
}

export default function FleetGroupAssignment({staff, groups, initialGroup, selectedRows, onClose, onApplied}) {
  const client = useQueryClient(), lock = useRef(false);
  const [target,setTarget] = useState(initialGroup == null ? '' : String(initialGroup));
  const [members,setMembers] = useState(() => (selectedRows||[]).map(({id,updated_at})=>({id,updated_at})));
  const [query,setQuery] = useState(''), [error,setError] = useState(''), [busy,setBusy] = useState(false);
  const users = staff.data||[], items = groups.data||[], fixed = Array.isArray(selectedRows);
  const selectedIds = new Set(members.map(m=>m.id));
  const shown = users.filter(s=>(!fixed || selectedIds.has(s.id)) &&
    [s.name,s.department,s.position].filter(Boolean).join(' ').toLowerCase().includes(query.trim().toLowerCase()));
  function toggle(user) {
    setMembers(prev=>prev.some(s=>s.id===user.id)?prev.filter(s=>s.id!==user.id):[...prev,{id:user.id,updated_at:user.updated_at}]);
  }
  const hasTarget = target==='base' || items.some(g=>String(g.id)===target);
  async function save(e) {
    e.preventDefault();
    if(lock.current || !hasTarget || !members.length || members.length>maxGroupMembers)return;
    lock.current=true;setBusy(true);setError('');
    const groupId=target==='base'?null:Number(target);
    try {
      const result=await api.assignFleetPermissionGroup({group_id:groupId,members});
      await Promise.all([client.invalidateQueries({queryKey:['fleet-permission-groups']}),client.invalidateQueries({queryKey:qk.staff()}),
        client.invalidateQueries({queryKey:['fleet-team-audit']})]);
      onApplied({groupId,count:result.count,confirmed:members.length});onClose();
    } catch(cause) {
      setError(cause.message||'권한 그룹을 적용하지 못했습니다.');
      if(cause.status===409||cause.status===404){
        const [fresh,available]=await Promise.all([staff.refetch(),groups.refetch()]);
        if(fresh.isSuccess){
          const latest=(fresh.data||[]).filter(s=>selectedIds.has(s.id)&&canAssignFleetMember(s));
          setMembers(latest.map(({id,updated_at})=>({id,updated_at})));
          setError('사용자 또는 그룹 정보가 변경되었습니다. 새로 조회한 대상 '+latest.length+'명을 확인한 뒤 다시 적용해 주세요.');
        }
        if(available.isSuccess&&groupId!=null&&!available.data.some(g=>g.id===groupId))setTarget('');
      }
    } finally {lock.current=false;setBusy(false);}
  }
  return <Modal open size="lg" title={fixed?'권한 그룹 적용':'사용자 그룹 배정'} onClose={busy?undefined:onClose}>
    <form className="fleet-group-form" onSubmit={save}>
      <FormField label="적용할 그룹"><Select value={target} disabled={busy||groups.isPending||Boolean(groups.error)} onChange={e=>setTarget(e.target.value)}>
        <option value="" disabled>권한 그룹 선택</option>{items.map(g=><option key={g.id} value={g.id}>{g.name}</option>)}<option value="base">기본 역할로 복원</option>
      </Select></FormField>
      {target==='base'&&<p className="fleet-group-warning">그룹 제한을 해제하면 선택한 사용자에게 기본 역할의 권한이 복원됩니다.</p>}
      {groups.error&&<BusinessError onRetry={groups.refetch}>권한 그룹을 불러오지 못했습니다.</BusinessError>}
      {staff.error&&<BusinessError onRetry={staff.refetch}>사용자를 불러오지 못했습니다.</BusinessError>}
      {!fixed&&<FormField label="사용자 검색"><Input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="이름, 부서, 직책"/></FormField>}
      <fieldset><legend>배정할 사용자 · {members.length}명 선택</legend><div className="fleet-group-selector">{shown.map(s=>{
        const checked=selectedIds.has(s.id);
        return <label key={s.id}>{!fixed&&<input type="checkbox" checked={checked} disabled={busy||!canAssignFleetMember(s)||(!checked&&members.length>=maxGroupMembers)} onChange={()=>toggle(s)}/>}
          <span><strong>{s.name}</strong><small>{[s.department,fleetRoles[s.access_role],items.find(g=>g.id===s.permission_group_id)?.name||'기본 역할',!s.active?'비활성':''].filter(Boolean).join(' · ')}</small></span></label>;
      })}{!shown.length&&<p>조회된 사용자가 없습니다.</p>}</div></fieldset>
      {error&&<BusinessError>{error}</BusinessError>}
      <div className="business-dialog-actions"><Button type="button" variant="ghost" disabled={busy} onClick={onClose}>취소</Button>
      <Button type="submit" busy={busy} disabled={!members.length||!hasTarget||groups.isPending||Boolean(groups.error)||Boolean(staff.error)}>{fixed?'그룹 적용':'배정 적용'}</Button></div>
    </form>
  </Modal>;
}
