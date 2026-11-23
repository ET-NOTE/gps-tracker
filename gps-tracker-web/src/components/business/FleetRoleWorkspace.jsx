import React, { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { qk, useStaff } from '../../state';
import { confirmDialog } from '../Dialog';
import Icon from '../Icon';
import { BusinessButton, BusinessError } from './BusinessWorkspace';
import { fleetRoles } from './FleetAccess';
import FleetGroupAssignment from './FleetGroupAssignment';
import { hideOutsideMockup } from '../../lib/mockupHidden';

// One screen for every permission group, as in the mockup: the built-in roles (read-only)
// and the company's own groups (editable), with a group list on the left and the editor on the right.
const roleDescriptions = {
  owner: '회사 계정과 이용권을 포함한 모든 권한을 가집니다.', admin: '전체 차량과 조직의 운영을 관리합니다.',
  department_manager: '소속 부서의 차량과 사용자를 관리합니다.', member: '본인의 예약, 운행, 지출을 확인합니다.',
};
const roleScopes = { owner: '전체', admin: '전체', department_manager: '소속 부서', member: '본인' };
// [key, label, roles that have it by default, editable in a company group]
const capabilities = [
  ['manage_vehicles', '차량 등록·수정', ['owner', 'admin'], true],
  ['write_reservations', '예약 등록·변경·취소', ['owner', 'admin', 'department_manager', 'member'], true],
  ['review_reservations', '예약 승인·반려', ['owner', 'admin', 'department_manager'], true],
  ['write_trips', '운행일지 수정·확정', ['owner', 'admin', 'department_manager', 'member'], true],
  ['manage_reports', '운행기록 지정·보정', ['owner', 'admin', 'department_manager'], false],
  ['write_expenses', '지출·영수증 등록 및 수정', ['owner', 'admin', 'department_manager', 'member'], true],
  ['review_expenses', '지출 승인·반려', ['owner', 'admin', 'department_manager'], true],
  ['manage_team', '사용자·조직 관리', ['owner', 'admin'], false],
  ['billing', '이용권 결제', ['owner'], false],
];
const menus = [
  ['차량 관리', ['manage_vehicles']], ['차량 예약', ['write_reservations', 'review_reservations']],
  ['운행일지', ['write_trips', 'manage_reports']], ['지출 관리', ['write_expenses', 'review_expenses']],
  ['관리 설정', ['manage_team', 'billing']],
];
const byKey = Object.fromEntries(capabilities.map(c => [c[0], c]));

export default function FleetRoleWorkspace({ access, onMembers, onAudit, withGroups }) {
  const client = useQueryClient(), staff = useStaff();
  const groups = useQuery({ queryKey: ['fleet-permission-groups'], queryFn: () => api.fleetPermissionGroups(), enabled: withGroups });
  const items = groups.data || [];
  const [selected, setSelected] = useState('role:' + access.role);
  const [draft, setDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [assigning, setAssigning] = useState(false);
  const lock = useRef(false);
  const people = staff.data || [];
  const group = selected.startsWith('group:') ? items.find(g => String(g.id) === selected.slice(6)) : null;
  const role = selected.startsWith('role:') ? selected.slice(5) : null;
  const creating = selected === 'new';
  useEffect(() => {
    if (group) setDraft({ name: group.name, description: group.description || '', permissions: [...group.permissions] });
    else if (creating) setDraft({ name: '', description: '', permissions: [] });
    else setDraft(null);
    setError('');
  }, [selected, group?.updated_at]); // eslint-disable-line react-hooks/exhaustive-deps
  const roleCount = r => people.filter(s => s.access_role === r && s.permission_group_id == null).length;
  const total = Object.keys(fleetRoles).length + items.length;
  const dirty = draft && (creating || draft.name.trim() !== group?.name || draft.description.trim() !== (group?.description || '') || [...draft.permissions].sort().join() !== [...(group?.permissions || [])].sort().join());

  async function run(task, done) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = await task();
      await Promise.all([client.invalidateQueries({ queryKey: ['fleet-permission-groups'] }), client.invalidateQueries({ queryKey: qk.staff() }), client.invalidateQueries({ queryKey: ['fleet-team-audit'] })]);
      done?.(result);
    } catch (cause) {
      setError(cause.message || '권한 그룹을 변경하지 못했습니다.');
      if (cause.status === 409 || cause.status === 404) await groups.refetch();
    } finally { lock.current = false; setBusy(false); }
  }
  const save = () => run(() => {
    const body = { name: draft.name.trim(), description: draft.description.trim(), permissions: draft.permissions };
    return creating ? api.createFleetPermissionGroup(body) : api.updateFleetPermissionGroup(group.id, { ...body, updated_at: group.updated_at });
  }, saved => { setSelected('group:' + saved.id); setMessage('권한 그룹을 저장했습니다.'); });
  const copy = () => run(() => api.createFleetPermissionGroup({ name: group.name + ' 복사', description: group.description || '', permissions: [...group.permissions] }),
    saved => { setSelected('group:' + saved.id); setMessage('그룹을 복사했습니다.'); });
  // A built-in role becomes a starting point for a company group with the permissions a group may hold.
  const copyRole = () => run(() => api.createFleetPermissionGroup({ name: fleetRoles[role] + ' 복사', description: roleDescriptions[role] || '', permissions: capabilities.filter(c => c[3] && c[2].includes(role)).map(c => c[0]) }),
    saved => { setSelected('group:' + saved.id); setMessage('기본 역할을 맞춤 그룹으로 복사했습니다.'); });
  const remove = async () => {
    if (!await confirmDialog({ title: '권한 그룹 삭제', body: `‘${group.name}’ 그룹을 삭제할까요?`, confirmLabel: '삭제', danger: true })) return;
    run(() => api.deleteFleetPermissionGroup(group.id, group.updated_at), () => { setSelected('role:' + access.role); setMessage('그룹을 삭제했습니다.'); });
  };
  const allowedFor = key => {
    if (draft) return draft.permissions.includes(key);
    if (role === access.role && access.group_id == null && typeof access[key] === 'boolean') return access[key];
    return byKey[key][2].includes(role);
  };
  const editable = key => Boolean(draft) && byKey[key][3] && !busy;
  const toggle = key => setDraft(d => ({ ...d, permissions: d.permissions.includes(key) ? d.permissions.filter(p => p !== key) : [...d.permissions, key] }));
  const editableKeys = capabilities.filter(c => c[3]).map(c => c[0]);

  return <div className="fleet-role-workspace">
    <div className="fleet-role-toolbar"><span>권한 그룹 {total}개</span><div className="fleet-role-head-actions">
      {onAudit && !hideOutsideMockup && <BusinessButton icon="clock" onClick={onAudit}>변경 이력</BusinessButton>}
      {withGroups && <BusinessButton primary icon="plus" disabled={groups.isPending || Boolean(groups.error) || busy} onClick={() => setSelected('new')}>그룹 추가</BusinessButton>}</div></div>
    {groups.error && <BusinessError onRetry={groups.refetch}>맞춤 권한 그룹을 불러오지 못했습니다.</BusinessError>}
    <section className="fleet-role-panel" aria-label="권한 그룹">
      <div className="fleet-role-list" aria-label="권한 그룹 선택"><h3 className="fleet-role-list-title">그룹 목록</h3>
        {Object.entries(fleetRoles).map(([key, name]) => <button key={key} type="button" aria-pressed={selected === 'role:' + key} onClick={() => setSelected('role:' + key)}>
          <span>{name}</span><small>{key === access.role && access.group_id == null ? '내 권한' : roleCount(key) + '명'}</small><em className="fleet-role-desc">{roleDescriptions[key]}</em>
        </button>)}
        {items.map(g => <button key={g.id} type="button" aria-pressed={selected === 'group:' + g.id} onClick={() => setSelected('group:' + g.id)}>
          <span>{g.name}</span><small>{g.members}명</small><em className="fleet-role-desc">{g.description || '회사에서 만든 맞춤 그룹'}</em>
        </button>)}
        {creating && <button type="button" aria-pressed="true"><span>새 권한 그룹</span><em className="fleet-role-desc">저장 전</em></button>}
      </div>
      <div className="fleet-role-detail">
        <header><div><h3>{creating ? '새 권한 그룹' : group ? group.name : fleetRoles[role]}</h3>
          <p>{draft ? '변경한 권한은 이 그룹의 사용자에게 함께 적용됩니다.' : roleDescriptions[role]}</p></div>
          <div className="fleet-role-head-actions">
            {role && role !== 'owner' && access.manage_team && <button type="button" className="business-button" onClick={() => onMembers(role)}>사용자 보기</button>}
            {role && withGroups && <button type="button" className="business-button fleet-role-icon-button" aria-label="맞춤 그룹으로 복사" title="맞춤 그룹으로 복사" disabled={busy || groups.isPending || Boolean(groups.error)} onClick={copyRole}><Icon name="copy" size={15}/></button>}
            {group && <><button type="button" className="business-button" disabled={busy} onClick={() => setAssigning(true)}>사용자 배정</button>
              <button type="button" className="business-button fleet-role-icon-button" aria-label="그룹 복사" title="그룹 복사" disabled={busy} onClick={copy}><Icon name="copy" size={15}/></button>
              <button type="button" className="business-button fleet-role-icon-button" aria-label="그룹 삭제" title={group.members ? '배정된 사용자가 있어 삭제할 수 없습니다.' : '그룹 삭제'} disabled={busy || group.members > 0} onClick={remove}><Icon name="trash" size={15}/></button></>}
          </div>
        </header>
        <div className="fleet-role-fields">
          <label>그룹 이름<input value={draft ? draft.name : fleetRoles[role]} maxLength={60} disabled={!draft || busy} placeholder="예: 차량 관리자" onChange={e => setDraft(d => ({ ...d, name: e.target.value }))}/></label>
          <label>조회 범위<select value="scope" disabled><option value="scope">{draft ? '사용자 기본 역할 범위' : roleScopes[role]}</option></select></label>
          <label className="fleet-role-field-wide">설명{draft ? <input value={draft.description} maxLength={200} disabled={busy} placeholder="그룹의 용도를 적어 주세요. 예: 차량 등록과 예약 승인 담당" onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}/> : <input value={roleDescriptions[role]} disabled readOnly/>}</label>
        </div>
        <div className="fleet-role-matrix-head"><h4 className="fleet-role-matrix-title">메뉴별 권한</h4>
          {<button type="button" className="fleet-role-select-all" disabled={!draft || busy} onClick={() => setDraft(d => ({ ...d, permissions: editableKeys.every(k => d.permissions.includes(k)) ? [] : editableKeys }))}>
            {draft && editableKeys.every(k => draft.permissions.includes(k)) ? '전체 해제' : '전체 선택'}</button>}</div>
        <div className="fleet-role-matrix">{menus.map(([menu, keys]) => <div key={menu} className="fleet-role-matrix-row"><strong>{menu}</strong><ul>{keys.map(key => {
          const on = allowedFor(key), canEdit = editable(key);
          return <li key={key} className={(on ? 'allowed' : '') + (canEdit ? ' editable' : '')}>
            <label><input type="checkbox" checked={on} disabled={!canEdit} onChange={() => toggle(key)}/><span className="fleet-role-check" aria-hidden="true">{on && <Icon name="check" size={11}/>}</span>{byKey[key][1]}</label>
          </li>;
        })}</ul></div>)}</div>
        {draft ? <p className="fleet-role-matrix-note">사용자·조직 관리, 이용권 결제, 운행기록 보정은 맞춤 그룹에 줄 수 없습니다. 그룹에 배정하면 회사 설정 관리는 제한됩니다.</p>
          : <div className="fleet-role-matrix-note"><p>수정·승인 권한을 선택하면 해당 항목의 조회 권한도 함께 적용됩니다.</p><p>관리자 그룹의 사용자 관리와 관리 설정 권한은 유지됩니다.</p></div>}
        {error && <BusinessError>{error}</BusinessError>}
        {message && <p className="fleet-role-matrix-note" role="status">{message}</p>}
        {draft && <footer className="fleet-role-actions">
          <button type="button" className="business-button" disabled={busy || !dirty} onClick={() => creating ? setSelected('role:' + access.role) : setDraft({ name: group.name, description: group.description || '', permissions: [...group.permissions] })}>{creating ? '취소' : '되돌리기'}</button>
          <button type="button" className="business-button is-primary" disabled={busy || !dirty || !draft.name.trim()} onClick={save}>{busy ? '저장 중…' : '변경사항 저장'}</button>
        </footer>}
      </div>
    </section>
    {assigning && <FleetGroupAssignment staff={staff} groups={groups} initialGroup={group?.id} onClose={() => setAssigning(false)}
      onApplied={({ groupId, count }) => { if (groupId) setSelected('group:' + groupId); setMessage('사용자 ' + count + '명의 권한 그룹을 변경했습니다.'); }}/>}
  </div>;
}
