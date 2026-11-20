import { useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { useRentalPhotos, useUploadRentalPhoto, useDeleteRentalPhoto } from '../../state';
import { PHOTO_KINDS, PHOTO_TYPES, photoGroups, photoTimestamp, prepareRentalPhoto } from '../../lib/rentalPhotos';
import { kstDateTime } from '../../lib/businessExport';
import { FormField, Select, Button } from '../ui';

export function ContractPhotos({ contractId, editable = false, defaultPhase = 'pickup', onBusyChange, onDraftChange }) {
  const result = useRentalPhotos(contractId), remove = useDeleteRentalPhoto();
  const [filter, setFilter] = useState('all'), [confirmId, setConfirmId] = useState(null), [deleteError, setDeleteError] = useState(''), [uploadBusy, setUploadBusy] = useState(false);
  const deleting = useRef(false);
  const busy = uploadBusy || remove.isPending;
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);
  async function deletePhoto(photo) {
    if (deleting.current || busy) return;
    deleting.current = true; setDeleteError('');
    try { await remove.mutateAsync({ photoId: photo.id, contractId }); setConfirmId(null); }
    catch { setDeleteError('사진을 삭제하지 못했습니다. 다시 시도해 주세요.'); }
    finally { deleting.current = false; }
  }
  const photos = result.data || [], { groups, other } = photoGroups(photos, filter);
  const card = photo => <Photo key={photo.id} photo={photo} editable={editable} busy={busy} confirm={confirmId === photo.id}
    onAsk={() => { setDeleteError(''); setConfirmId(photo.id); }} onCancel={() => setConfirmId(null)} onDelete={() => deletePhoto(photo)} />;
  return <div className="business-photos">
    {editable && <PhotoUpload key={contractId} contractId={contractId} defaultPhase={defaultPhase} disabled={remove.isPending} onBusyChange={setUploadBusy} onDraftChange={onDraftChange} onSaved={() => setFilter('all')} />}
    {result.isLoading ? <p className="business-note">사진 목록을 불러오는 중…</p> : result.error ? <PhotoError onRetry={result.refetch}>사진 목록을 불러오지 못했습니다.</PhotoError> : <>
      <div className="business-photo-filters" aria-label="사진 종류 필터">{[{ id: 'all', label: '전체' }, ...PHOTO_TYPES].map(type => <button type="button" className="business-photo-filter" key={type.id} aria-pressed={filter === type.id} onClick={() => setFilter(type.id)}>{type.label} <span>{type.id === 'all' ? photos.length : photos.filter(p => [`pickup_${type.id}`, `return_${type.id}`].includes(p.kind)).length}</span></button>)}</div>
      <p className="business-note">사진 아래에는 등록 시각이 표시됩니다. 같은 위치·각도의 사진인지 확인하며 비교하세요.</p>
      {deleteError && <p className="business-error" role="alert">{deleteError}</p>}
      {!groups.length && !other.length && <p className="business-photo-empty">{photos.length ? '이 종류에 등록된 사진이 없습니다.' : '이 계약에 등록된 사진이 없습니다.'}</p>}
      {groups.map(group => <section className="business-photo-comparison" key={group.id}><h4>{group.label} 비교</h4><div className="business-photo-pair">{[['인수 시점', group.pickup], ['반납 시점', group.returned]].map(([label, items]) => <section key={label}><h5>{label} <span>{items.length}장</span></h5>{items.length ? items.map(card) : <p className="business-photo-empty">등록된 사진 없음</p>}</section>)}</div></section>)}
      {other.length > 0 && <section><h4>기타 사진</h4>{other.map(card)}</section>}
    </>}
  </div>;
}

function PhotoUpload({ contractId, defaultPhase, disabled, onBusyChange, onDraftChange, onSaved }) {
  const [kind, setKind] = useState(`${defaultPhase}_damage`), [prepared, setPrepared] = useState(null), [preparing, setPreparing] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const file = useRef(null), camera = useRef(null), alive = useRef(true), saving = useRef(false), choosing = useRef(false);
  const upload = useUploadRentalPhoto();
  const busy = preparing || upload.isPending;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => { onDraftChange?.(!!prepared); }, [prepared, onDraftChange]);
  useEffect(() => () => { onBusyChange?.(false); onDraftChange?.(false); }, [onBusyChange, onDraftChange]);
  async function choose(event) {
    const selected = event.target.files?.[0]; event.target.value = '';
    if (!selected || choosing.current || busy || disabled) return;
    choosing.current = true; setPreparing(true); setError(''); setMessage('');
    try { const value = await prepareRentalPhoto(selected); if (alive.current) setPrepared(value); }
    catch (e) { if (alive.current) setError(e.message); }
    finally { choosing.current = false; if (alive.current) setPreparing(false); }
  }
  async function save() {
    if (!prepared || saving.current || busy || disabled) return;
    saving.current = true; setError('');
    try { await upload.mutateAsync({ contractId, kind, dataUrl: prepared.dataUrl }); if (alive.current) { setPrepared(null); setMessage(`${PHOTO_KINDS[kind]} 사진을 저장했습니다.`); onSaved?.(); } }
    catch { if (alive.current) setError('사진을 저장하지 못했습니다. 선택한 사진은 유지됩니다. 연결을 확인한 뒤 다시 저장해 주세요.'); }
    finally { saving.current = false; }
  }
  return <section className="business-photo-upload" aria-label="사진 추가"><h4>사진 추가</h4>
    <FormField label="저장할 사진 종류"><Select disabled={busy || disabled} value={kind} onChange={e => { setKind(e.target.value); setMessage(''); }}>{Object.entries(PHOTO_KINDS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</Select></FormField>
    <input aria-label="사진 파일 선택" ref={file} type="file" accept="image/jpeg,image/png,image/webp" onChange={choose} hidden />
    <input aria-label="사진 촬영 파일" ref={camera} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" onChange={choose} hidden />
    <div className="business-photo-upload-actions"><Button variant="ghost" disabled={busy || disabled} onClick={() => file.current?.click()}>사진 선택</Button><Button variant="ghost" disabled={busy || disabled} onClick={() => camera.current?.click()}>촬영하기</Button></div>
    <p className="business-note">JPG · PNG · WebP, 한 장당 10MB 이하. 사진 저장은 반납 완료와 별도로 적용됩니다.</p>
    {preparing && <p role="status">사진을 준비하는 중…</p>}
    {error && <p className="business-error" role="alert">{error}</p>}{message && <p className="business-photo-saved" role="status">{message}</p>}
    {prepared && <div className="business-photo-draft"><img src={prepared.dataUrl} alt="저장 전 사진 미리보기" /><p>{prepared.name}</p><p className="business-note">종류와 사진을 확인해 저장하거나, 선택을 취소해 주세요.</p>
      <div className="business-photo-upload-actions"><Button variant="ghost" disabled={busy || disabled} onClick={() => { setPrepared(null); setError(''); }}>선택 취소</Button><Button variant="primary" busy={upload.isPending} disabled={preparing || disabled} onClick={save}>사진 저장</Button></div>
    </div>}
  </section>;
}

function Photo({ photo, editable, busy, confirm, onAsk, onCancel, onDelete }) {
  const [url, setUrl] = useState(null), [error, setError] = useState(false), [retry, setRetry] = useState(0), [expanded, setExpanded] = useState(false);
  const [element, setElement] = useState(null), [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!element) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '100px' });
    observer.observe(element); return () => observer.disconnect();
  }, [element]);
  useEffect(() => {
    if (!visible) return;
    let disposed = false, objectUrl; setUrl(null); setError(false);
    api.fetchRentalPhoto(photo.id).then(value => { if (disposed) URL.revokeObjectURL(value); else { objectUrl = value; setUrl(value); } }).catch(() => { if (!disposed) setError(true); });
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [photo.id, visible, retry]);
  const label = PHOTO_KINDS[photo.kind] || '계약 사진', time = photoTimestamp(photo);
  return <figure ref={setElement} className={`business-history-photo${expanded ? ' expanded' : ''}`}>
    {url && !error ? <button className="business-photo-button" type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)} aria-label={`${label} ${expanded ? '접기' : '확대'}`}><img src={url} alt={label} onError={() => setError(true)} /></button> : error ? <PhotoError onRetry={() => setRetry(v => v + 1)}>사진을 불러오지 못했습니다.</PhotoError> : <div className="business-photo-loading">사진 불러오는 중…</div>}
    <figcaption>{label}<br />{time && Number.isFinite(Date.parse(time)) ? `${kstDateTime(time)} 등록` : '등록 시각 확인 필요'}</figcaption>
    {editable && <div className="business-photo-delete">{confirm ? <><p>이 사진을 삭제할까요? 삭제하면 되돌릴 수 없습니다.</p><div><Button variant="ghost" disabled={busy} onClick={onCancel}>유지</Button><Button variant="danger" disabled={busy} onClick={onDelete}>삭제 확인</Button></div></> : <Button variant="ghost" disabled={busy} onClick={onAsk} aria-label={`${label} 사진 삭제`}>사진 삭제</Button>}</div>}
  </figure>;
}
function PhotoError({ children, onRetry }) { return <div role="alert" className="business-error">{children}<button className="business-button" onClick={onRetry}>다시 시도</button></div>; }
