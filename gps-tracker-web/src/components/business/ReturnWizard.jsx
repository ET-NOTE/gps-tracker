import { useEffect, useRef, useState } from 'react';
import { Modal, FormField, Input, Textarea, Button } from '../ui';
import { useReturnRental } from '../../state';
import { ContractPhotos } from './RentalPhotos';
import { computeSettlementPreview, validateReturn, returnPayload } from '../../lib/rentalReturn';
import { kstDateTime } from '../../lib/businessExport';

const steps = ['반납 정보', '사진·요금 확인', '최종 확인'];
const localNow = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); };

export default function ReturnWizard({ contract, onClose, onDone }) {
  const [step, setStep] = useState(0), [error, setError] = useState('');
  const [form, setForm] = useState(() => ({ returnedAt: localNow(), odometer: contract.return_odometer_km ?? '', location: contract.return_location ?? '', extraFee: '', extraLabel: '', note: '' }));
  const title = useRef(null), submitting = useRef(false);
  const mutation = useReturnRental();
  const [photoBusy, setPhotoBusy] = useState(false), [photoDraft, setPhotoDraft] = useState(false), [photoCloseWarning, setPhotoCloseWarning] = useState(false);
  const close = () => { if (photoDraft) { setPhotoCloseWarning(true); return; } onClose(); };
  const update = key => e => { setError(''); setForm(v => ({ ...v, [key]: e.target.value })); };
  const preview = computeSettlementPreview(contract, { returnOdometerKm: form.odometer === '' ? null : Number(form.odometer), extraFeeKrw: Number(form.extraFee), extraLabel: form.extraLabel.trim(), returnedAt: new Date(form.returnedAt) });
  const issues = validateReturn(contract, form);
  useEffect(() => { title.current?.focus(); title.current?.closest('.gps-modal-body')?.scrollTo(0, 0); }, [step]);
  function next() {
    const issue = step === 0 ? issues.information : issues.charges;
    if (issue) { setError(issue); return; }
    setError(''); setStep(v => v + 1);
  }
  async function submit() {
    if (submitting.current) return;
    const issue = issues.information || issues.charges;
    if (issue) { setError(issue); return; }
    submitting.current = true; setError('');
    try { await mutation.mutateAsync({ id: contract.id, body: returnPayload(form) }); onDone(); }
    catch (e) { setError(e.message || '반납 처리에 실패했습니다. 입력한 내용을 유지했습니다. 다시 시도해 주세요.'); }
    finally { submitting.current = false; }
  }
  const busy = mutation.isPending || photoBusy;
  return <Modal open onClose={busy ? undefined : close} closeOnBackdrop={false} closeOnEsc={!busy} size="lg" title="반납 처리"
    subtitle={`${contract.license_plate || contract.device_name} · ${contract.renter_name}`}
    footer={<><Button variant="ghost" disabled={busy || photoDraft} onClick={() => { setError(''); step ? setStep(v => v - 1) : close(); }} style={{ flex: 1 }}>{step ? '이전' : '취소'}</Button>
      <Button variant="primary" size="lg" busy={busy} disabled={photoDraft} onClick={step === 2 ? submit : next} style={{ flex: 2 }}>{step === 2 ? '확인 후 반납·정산 완료' : '다음 단계'}</Button></>}>
    <ol className="business-return-steps" aria-label="반납 진행 단계">{steps.map((label, i) => <li key={label} aria-current={i === step ? 'step' : undefined}><span>{i + 1}</span>{label}</li>)}</ol>
    <h3 className="business-return-title" ref={title} tabIndex={-1}>{step + 1}. {steps[step]}</h3>
    {error && <p className="business-error" role="alert">{error}</p>}
    {photoCloseWarning && photoDraft && <p className="business-error" role="alert">선택한 사진을 저장하거나 선택 취소한 후 닫아 주세요.</p>}
    {photoDraft && <p className="business-return-notice" role="status">선택한 사진을 저장하거나 선택 취소하면 다음 단계로 이동할 수 있습니다. ‘인수·반납 사진 확인 및 추가’에서 확인해 주세요.</p>}
    {step === 0 && <>
      <p className="business-note">차량과 계기판을 확인해 실제 반납 정보를 입력하세요. 마지막 단계에서만 반납이 저장됩니다.</p>
      <FormField label="실제 반납 시각" hint="입력 시각은 현재 기기 시간대 기준입니다."><Input type="datetime-local" value={form.returnedAt} onChange={update('returnedAt')} /></FormField>
      <FormField label="반납 오도미터 (km)" hint={contract.pickup_odometer_km == null ? '인수 오도미터가 없어 초과 주행 요금을 계산할 수 없습니다.' : `인수 오도미터: ${contract.pickup_odometer_km.toLocaleString()} km · 계기판 누적 주행거리를 입력하세요.`}>
        <Input type="number" min={contract.pickup_odometer_km ?? 0} step="1" value={form.odometer} onChange={update('odometer')} placeholder="계기판의 누적 km" />
      </FormField>
      <FormField label="반납 장소 (선택)"><Input value={form.location} onChange={update('location')} /></FormField>
      <FormField label="메모 (선택)"><Textarea value={form.note} onChange={update('note')} /></FormField>
    </>}
    {step === 1 && <>
      <div className="business-return-contract"><strong>계약 요금 기준</strong><p>{kstDateTime(contract.starts_at)} ~ {kstDateTime(contract.ends_at)}</p><p>계약 기간 기본 요금에 초과 주행·지연 반납·입력한 기타 요금이 합산됩니다.</p></div>
      <FormField label="기타 요금 사유 (세차·파손·연료 등)"><Input value={form.extraLabel} onChange={update('extraLabel')} placeholder="예: 세차비 / 할인 사유" /></FormField>
      <FormField label="기타 금액 (원)" hint="할인은 음수로 입력하세요. 0원이 아니면 사유를 적어 주세요."><Input type="number" step="1" value={form.extraFee} onChange={update('extraFee')} placeholder="0" /></FormField>
      <Settlement preview={preview} deposit={contract.deposit_krw} />
      <details className="business-return-photos"><summary>인수·반납 사진 확인 및 추가</summary><ContractPhotos contractId={contract.id} editable defaultPhase="return" onBusyChange={setPhotoBusy} onDraftChange={setPhotoDraft} /></details>
    </>}
    {step === 2 && <>
      <dl className="business-detail-facts"><div><dt>실제 반납</dt><dd>{kstDateTime(form.returnedAt)} (한국 시간)</dd></div><div><dt>반납 오도미터</dt><dd>{form.odometer === '' ? '미입력' : `${Number(form.odometer).toLocaleString()} km`}</dd></div><div><dt>반납 장소</dt><dd>{form.location || '미입력'}</dd></div><div><dt>메모</dt><dd>{form.note || '없음'}</dd></div></dl>
      {form.odometer === '' && <p className="business-return-notice">오도미터를 입력하지 않아 초과 주행 요금은 포함되지 않았습니다.</p>}
      <Settlement preview={preview} deposit={contract.deposit_krw} />
      <p className="business-note">완료하면 계약이 반납 완료로 바뀌고 정산 내역이 저장됩니다. 실제 결제나 환급 송금은 수행하지 않습니다.</p>
    </>}
  </Modal>;
}

function Settlement({ preview, deposit }) {
  return <div className="business-return-settlement"><h4>정산 미리보기</h4>{preview.lines.map(line => <div key={line.kind}><span>{line.label}</span><strong>{line.amount.toLocaleString()}원</strong></div>)}
    <div className="total"><span>합계</span><strong>{preview.subtotal.toLocaleString()}원</strong></div><div><span>보증금</span><strong>{(deposit || 0).toLocaleString()}원</strong></div>
    <div className="balance"><span>{preview.balance >= 0 ? '임차인에게 환급' : '임차인에게 추가 청구'}</span><strong>{Math.abs(preview.balance).toLocaleString()}원</strong></div>
  </div>;
}
