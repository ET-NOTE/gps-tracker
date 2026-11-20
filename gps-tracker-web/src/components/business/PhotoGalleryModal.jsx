import { useState } from 'react';
import { Modal } from '../ui';
import { ContractPhotos } from './RentalPhotos';

export default function PhotoGalleryModal({ contract, onClose }) {
  const [busy, setBusy] = useState(false), [draft, setDraft] = useState(false), [closeWarning, setCloseWarning] = useState(false);
  const close = () => { if (busy) return; if (draft) { setCloseWarning(true); return; } onClose(); };
  return <Modal open onClose={busy ? undefined : close} closeOnBackdrop={false} closeOnEsc={!busy} size="lg" title="계약 사진" subtitle={`${contract.license_plate || contract.device_name} · ${contract.renter_name}`}>
    {closeWarning && draft && <p className="business-return-notice" role="alert">선택한 사진을 저장하거나 선택 취소한 후 닫아 주세요.</p>}
    <ContractPhotos contractId={contract.id} editable defaultPhase={contract.status === 'returned' ? 'return' : 'pickup'} onBusyChange={setBusy} onDraftChange={setDraft} />
  </Modal>;
}
