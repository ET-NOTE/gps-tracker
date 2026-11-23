import React, {useRef, useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import Icon from '../Icon';
import {Button, FormField, Input, Modal} from '../ui';
import BusinessDrawer from './BusinessDrawer';
import {BusinessButton, BusinessEmpty, BusinessError, BusinessSection} from './BusinessWorkspace';
import {usePurposes} from './CompanyPurposePicker';
import {useFleetAccess} from './FleetAccess';
import './fleet-settings-controls.css';
import './fleet-trip-purposes.css';

function usage(item) {
  return item.reservation_count == null || item.trip_count == null
    ? null : item.reservation_count + item.trip_count;
}

function PurposeSwitch({checked, onChange, label, disabled}) {
  return <input className="fleet-setting-switch" type="checkbox" role="switch" aria-label={label}
    checked={checked} onChange={event=>onChange(event.target.checked)} disabled={disabled}/>;
}

export default function FleetTripPurposes() {
  const access = useFleetAccess();
  const request = usePurposes(), client = useQueryClient();
  const [search, setSearch] = useState(''), [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null), [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const lock = useRef(false);
  const items = request.data || [];
  const shown = items.filter(p=>p.name.toLocaleLowerCase('ko-KR').includes(search.trim().toLocaleLowerCase('ko-KR')));
  const selected = items.find(item=>item.id===selectedId);
  const canEdit = access.manage_team;
  function open(item, remove=false) {
    if (lock.current) return;
    setDraft(item ? {...item} : {name:'',active:true});
    setDeleting(remove);setError('');setMessage('');
  }
  function closeEditor() {
    if (!lock.current) {setDraft(null);setError('');}
  }
  function openDetails(id) {
    setSelectedId(id);setError('');setMessage('');
  }
  async function persist(item, remove=false) {
    if (lock.current || !canEdit) return;
    lock.current=true;setBusy(true);setError('');setMessage('');
    try {
      if (remove) {
        const result = await api.deleteTripPurpose(item.id,item.updated_at);
        setMessage(result.archived ? '연결된 기록을 보존하고 사용을 중지했습니다.' : '운행 목적을 삭제했습니다.');
        if (!result.archived && selectedId===item.id) setSelectedId(null);
      } else {
        const body={name:item.name.trim(),active:item.active};
        if (item.id) await api.updateTripPurpose(item.id,{...body,updated_at:item.updated_at});
        else await api.createTripPurpose(body);
        setMessage('운행 목적을 저장했습니다.');
      }
      setDraft(null);
      await Promise.all([
        client.invalidateQueries({queryKey:['fleet-trip-purposes']}),
        client.invalidateQueries({queryKey:['business','corporate','vehicle-reservations']}),
        client.invalidateQueries({queryKey:['fleet-analytics','trips']}),
      ]);
    } catch (e) {
      setError(e.message || '운행 목적을 저장하지 못했습니다.');
      if (e.status===409 || e.status===404) await request.refetch();
    } finally {lock.current=false;setBusy(false);}
  }
  const used=draft && usage(draft)>0;
  return <div className="fleet-purpose-page">
    <div className="fleet-record-toolbar fleet-purpose-tools">
      <label className="fleet-inline-search"><Icon name="search" size={15}/>
        <input type="search" aria-label="운행 목적 검색" placeholder="운행 목적 검색" value={search} onChange={e=>setSearch(e.target.value)}/></label>
      {canEdit && <BusinessButton primary icon="plus" disabled={busy} onClick={()=>open(null)}>목적 추가</BusinessButton>}
    </div>
    <BusinessSection title={'운행 목적 '+shown.length+'개'} action={<small>사용 중 {items.filter(p=>p.active).length}개</small>}>
      {request.error?<BusinessError onRetry={request.refetch}>운행 목적을 불러오지 못했습니다.</BusinessError>:
        request.isPending?<p className="fleet-purpose-info" role="status">운행 목적 조회 중…</p>:
        <div className="fleet-purpose-scroll" role="region" aria-label="운행 목적 목록" tabIndex={0}><table className="fleet-purpose-table">
          <thead><tr><th scope="col">운행 목적</th><th scope="col">참조 기록</th><th scope="col">사용 여부</th>{canEdit&&<th scope="col" aria-label="관리"/>}</tr></thead>
          <tbody>{shown.length===0&&<tr className="fleet-table-empty-row"><td colSpan={canEdit?4:3}><BusinessEmpty compact title={items.length?'검색 결과가 없습니다.':'등록된 운행 목적이 없습니다.'}/></td></tr>}{shown.map(p=><tr key={p.id} tabIndex={0} aria-label={p.name+' 운행 목적 상세 보기'}
            onClick={()=>openDetails(p.id)} onKeyDown={event=>{
              if (event.target===event.currentTarget && (event.key==='Enter'||event.key===' ')) {
                event.preventDefault();openDetails(p.id);
              }
            }}>
            <td>{p.name}</td><td>{usage(p)!=null?usage(p)+'건':'—'}</td>
            <td><div className="fleet-purpose-state">
              {canEdit && <label onClick={event=>event.stopPropagation()}>
                <PurposeSwitch checked={p.active} onChange={active=>persist({...p,active})} label={p.name+' 사용'} disabled={busy}/></label>}
              <small className={p.active?'is-active':''}>{p.active?'사용 중':'사용 중지'}</small></div></td>
            {canEdit&&<td><div className="fleet-purpose-actions" onClick={event=>event.stopPropagation()}>
              <button type="button" disabled={busy} aria-label={p.name+' 수정'} onClick={()=>open(p)}>수정</button>
              <button type="button" disabled={busy} aria-label={p.name+' 삭제'} onClick={()=>open(p,true)}>삭제</button></div></td>}
          </tr>)}</tbody>
        </table></div>}
    </BusinessSection>
    <p className="fleet-purpose-note">기존 예약이나 운행 기록에서 사용한 목적은 삭제 대신 사용 중지됩니다.</p>
    {message&&<p className="fleet-purpose-info" role="status">{message}</p>}
    {error&&!draft&&!selected&&<BusinessError>{error}</BusinessError>}
    {selected&&<BusinessDrawer title="운행 목적 상세" subtitle={selected.name} onClose={()=>setSelectedId(null)}>
      <div className="fleet-purpose-detail"><div className="fleet-purpose-detail-heading"><h3>{selected.name}</h3>
        <span className={selected.active?'is-active':''}>{selected.active?'사용 중':'사용 중지'}</span></div>
        <section><h4>사용 현황</h4><dl><div><dt>선택 가능 여부</dt><dd>{selected.active?'새 예약·운행일지에서 선택 가능':'새 예약·운행일지에서 제외'}</dd></div>
          {usage(selected)!=null&&<><div><dt>참조 기록</dt><dd>{usage(selected)}건</dd></div>
          <div><dt>예약 기록</dt><dd>{selected.reservation_count}건</dd></div>
          <div><dt>운행 기록</dt><dd>{selected.trip_count}건</dd></div></>}</dl></section>
        {error&&!draft&&<BusinessError>{error}</BusinessError>}
        {canEdit&&<footer><BusinessButton disabled={busy} onClick={()=>open(selected,true)}>삭제</BusinessButton>
          <BusinessButton disabled={busy} onClick={()=>persist({...selected,active:!selected.active})}>{selected.active?'사용 중지':'사용 재개'}</BusinessButton>
          <BusinessButton primary disabled={busy} onClick={()=>open(selected)}>정보 수정</BusinessButton></footer>}
      </div></BusinessDrawer>}
    {draft&&<Modal open mobileForm size={530} title={deleting?(used?'운행 목적 사용 중지':'운행 목적 삭제'):draft.id?'운행 목적 수정':'운행 목적 추가'} onClose={busy?undefined:closeEditor}>
      <form className="fleet-purpose-form" onSubmit={event=>{event.preventDefault();persist(draft,deleting);}}>
        {deleting?<p>{used?`‘${draft.name}’을 사용 중지할까요? 기존 예약과 운행에는 이름이 남습니다.`:`‘${draft.name}’을 삭제할까요?`}</p>:<>
          <FormField label="운행 목적"><Input required maxLength={50} placeholder="예: 거래처 방문" value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></FormField>
          <label className="fleet-purpose-check"><span>예약·운행일지에서 사용<small>사용을 중지해도 기존 기록은 유지됩니다.</small></span>
            <PurposeSwitch checked={draft.active} onChange={active=>setDraft({...draft,active})} label="운행 목적 사용"/></label>
          {used&&<small>이름을 바꾸면 기존 기록에도 새 이름이 표시됩니다.</small>}
        </>}
        {error&&<BusinessError>{error}</BusinessError>}
        <div className="business-dialog-actions"><Button type="button" variant="ghost" disabled={busy} onClick={closeEditor}>취소</Button>
          <Button type="submit" busy={busy} disabled={!deleting&&!draft.name.trim()}>{deleting?(used?'사용 중지':'삭제'):draft.id?'변경사항 저장':'목적 추가'}</Button></div>
      </form>
    </Modal>}
  </div>;
}
