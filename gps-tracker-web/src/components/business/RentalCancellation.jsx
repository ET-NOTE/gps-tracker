import { useState } from 'react';
import { api } from '../../api';
import { won } from '../../lib/rentalOffice';
import { Button, FormField, Input, Modal, Select, Textarea } from '../ui';

export default function RentalCancellation({ contract, onClose, onSaved }) {
  const [outcome, setOutcome] = useState('cancelled');
  const [fee, setFee] = useState('0');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requestKey] = useState(() => crypto.randomUUID());
  const feeValue = Number(fee);
  const validFee = fee.trim() !== '' && Number.isSafeInteger(feeValue) && feeValue >= 0 && feeValue <= 1_000_000_000;
  const valid = confirmed && validFee && !!reason.trim();
  function change(setter, value) {
    setter(value);
    setConfirmed(false);
    setError('');
  }
  async function save() {
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    try {
      const saved = await api.cancelRental(contract.id, {
        outcome, reason: reason.trim(), fee_krw: feeValue, request_key: requestKey,
      });
      await onSaved(saved);
    } catch (e) {
      setError(e.message || '예약 상태를 변경하지 못했습니다.');
    } finally {
      setBusy(false);
    }
  }
  return <Modal open title="취소·미방문 처리" subtitle={'예약 R-'+contract.id+' · '+contract.renter_name}
    onClose={busy ? undefined : onClose} footer={<><Button disabled={busy} onClick={onClose}>닫기</Button>
      <Button variant="primary" disabled={!valid} busy={busy} onClick={save}>처리 확정</Button></>}>
    <div className="rental-form-sections">
      <div className="rental-form-grid">
        <FormField label="처리 구분"><Select value={outcome} onChange={e=>change(setOutcome,e.target.value)}>
          <option value="cancelled">예약 취소</option><option value="no_show">미방문</option>
        </Select></FormField>
        <FormField label="취소 수수료 (원)"><Input type="number" min="0" max="1000000000" step="1"
          value={fee} onChange={e=>change(setFee,e.target.value)} required/></FormField>
      </div>
      <FormField label="처리 사유"><Textarea value={reason} required maxLength={500} rows={3} onChange={e=>change(setReason,e.target.value)}/></FormField>
      <p>기존 수납과 보증금을 반환할 때는 환불·보증금 메뉴에 별도로 기록해 주세요.</p>
      <label className="rental-check"><input type="checkbox" checked={confirmed} disabled={!validFee || !reason.trim()}
        onChange={e=>setConfirmed(e.target.checked)}/>{outcome==='no_show'?'미방문':'예약 취소'} 처리와 수수료 {validFee ? won(feeValue) : '금액'}을 확인했습니다.</label>
      {error && <p role="alert" className="business-error">{error}</p>}
    </div>
  </Modal>;
}
