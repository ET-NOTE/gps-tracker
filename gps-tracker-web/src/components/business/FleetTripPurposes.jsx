import React, {useRef, useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {useFleetAccess} from './FleetAccess';
import {BusinessButton, BusinessEmpty, BusinessError, BusinessSection} from './BusinessWorkspace';
import {Button, FormField, Input, Modal} from '../ui';
import {usePurposes} from './CompanyPurposePicker';
import './fleet-trip-purposes.css';

export default function FleetTripPurposes() {
  const access = useFleetAccess();
  const request = usePurposes(), client = useQueryClient();
  const [search,setSearch] = useState(''), [draft,setDraft] = useState(null), [deleting,setDeleting] = useState(false);
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [message,setMessage] = useState('');
  const lock = useRef(false);
  const items = request.data || [];
  const shown = items.filter(p=>p.name.toLocaleLowerCase('ko-KR').includes(search.trim().toLocaleLowerCase('ko-KR')));
  function open(item, remove=false) {
    setDraft(item ? {...item} : {name:'',active:true});
    setDeleting(remove);setError('');setMessage('');
  }
  const close = () => {if (!lock.current) setDraft(null);};
  async function save(e) {
    e.preventDefault();
    if (lock.current) return;
    lock.current=true;setBusy(true);setError('');
    try {
      if (deleting) {
        const result = await api.deleteTripPurpose(draft.id,draft.updated_at);
        setMessage(result.archived ? '연결된 기록을 보존하고 사용을 중지했습니다.' : '운행 목적을 삭제했습니다.');
      } else {
        const body={name:draft.name.trim(),active:draft.active};
        if (draft.id) await api.updateTripPurpose(draft.id,{...body,updated_at:draft.updated_at});
        else await api.createTripPurpose(body);
        setMessage('운행 목적을 저장했습니다.');
      }
      setDraft(null);
      // Lists carry the current purpose name. Refetch active or cached views after renaming.
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
  const used=draft && (draft.reservation_count>0 || draft.trip_count>0);
  return <div className="fleet-purpose-page"><BusinessSection title="회사 운행 목적" action={access.manage_team &&
    <BusinessButton primary icon="plus" onClick={()=>open(null)}>목적 추가</BusinessButton>}>
    {request.error?<BusinessError onRetry={request.refetch}>운행 목적을 불러오지 못했습니다.</BusinessError>:
      request.isPending?<p className="fleet-purpose-info" role="status">운행 목적 조회 중…</p>:<>
        <div className="fleet-purpose-tools"><Input aria-label="운행 목적 검색" type="search" placeholder="운행 목적 검색" value={search} onChange={e=>setSearch(e.target.value)}/>
          <span>전체 {items.length}개 · 사용 중 {items.filter(p=>p.active).length}개</span></div>
        {shown.length?<ul className="fleet-purpose-list">{shown.map(p=><li key={p.id}>
          <div><strong>{p.name}</strong>{p.reservation_count!=null&&<small>예약 {p.reservation_count}건 · 운행 {p.trip_count}건</small>}</div>
          <span className={p.active?'purpose-active':'purpose-inactive'}>{p.active?'사용 중':'사용 중지'}</span>
          {access.manage_team&&<div className="fleet-purpose-actions">
            <BusinessButton aria-label={`${p.name} 수정`} onClick={()=>open(p)}>수정</BusinessButton>
            <BusinessButton aria-label={`${p.name} 삭제`} onClick={()=>open(p,true)}>삭제</BusinessButton>
          </div>}
        </li>)}</ul>:<BusinessEmpty compact title={items.length?'검색 결과가 없습니다.':'등록된 운행 목적이 없습니다.'}/>}
      </>}
    {message&&<p className="fleet-purpose-info" role="status">{message}</p>}
  </BusinessSection>
  {draft&&<Modal open size="sm" title={deleting?(used?'운행 목적 사용 중지':'운행 목적 삭제'):draft.id?'운행 목적 수정':'운행 목적 추가'} onClose={busy?undefined:close}>
    <form className="fleet-purpose-form" onSubmit={save}>
      {deleting?<p>{used?`‘${draft.name}’을 사용 중지할까요? 기존 예약과 운행에는 이름이 남습니다.`:`‘${draft.name}’을 삭제할까요?`}</p>:<>
        <FormField label="목적 이름"><Input required maxLength={50} value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></FormField>
        <label className="fleet-purpose-check"><input type="checkbox" checked={draft.active} onChange={e=>setDraft({...draft,active:e.target.checked})}/>새 예약·운행기록에서 선택 가능</label>
        {used&&<small>이름을 바꾸면 기존 기록에도 새 이름이 표시됩니다.</small>}
      </>}
      {error&&<BusinessError>{error}</BusinessError>}
      <div className="business-dialog-actions"><Button type="button" variant="ghost" disabled={busy} onClick={close}>취소</Button>
        <Button type="submit" busy={busy} disabled={!deleting&&!draft.name.trim()}>{deleting?(used?'사용 중지':'삭제'):'저장'}</Button></div>
    </form>
  </Modal>}</div>;
}
