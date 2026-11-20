import { useEffect, useId, useRef, useState } from 'react';
import Icon from './Icon';
import './SimRegistrationHelp.css';

export default function SimRegistrationHelp({ inputId }) {
  const id = useId(), root = useRef(null), timer = useRef(null);
  const [open, setOpen] = useState(false), [pinned, setPinned] = useState(false);
  const close = () => { setOpen(false); setPinned(false); };
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!root.current?.contains(event.target)) close(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return <div ref={root} className="sim-registration-label"
    onPointerEnter={() => clearTimeout(timer.current)}
    onPointerLeave={() => { if (!pinned) timer.current = setTimeout(() => setOpen(false), 150); }}
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}
    onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); close(); } }}>
    <label htmlFor={inputId}>SIM 번호</label>
    <button type="button" className="sim-registration-info" aria-label="SIM 번호 등록 안내"
      aria-expanded={open} aria-controls={id} aria-describedby={open ? id : undefined}
      onPointerEnter={event => { if (event.pointerType !== 'touch') setOpen(true); }}
      onFocus={() => setOpen(true)} onClick={() => { setPinned(!pinned); setOpen(!pinned); }}>
      <Icon name="info" size={17} />
    </button>
    {open && <div id={id} role="tooltip" className="sim-registration-help" tabIndex={0}>
      <strong>SIM 번호로 연결하기</strong>
      <p>단말기를 켜고 LTE 연결 후, 1NCE 화면에 표시된 ICCID의 끝 8자리와 이름을 입력하세요. 처음 등록할 때도 같습니다.</p>
      <p>SIM 인쇄 번호의 끝 8자리나 전체 번호(19~20자리)도 사용할 수 있습니다. 끝번호가 중복될 때는 전체 번호를 입력하세요. 단말기 인증은 자동으로 별도 확인합니다.</p>
      <p>같은 계정에서 동일 SIM을 다시 연결하면 보관한 기록이 복원됩니다. 하드웨어가 다른 단말기여도 됩니다. 다른 계정에 연결된 SIM은 기존 계정에서 먼저 연결 해제해야 합니다.</p>
    </div>}
  </div>;
}
