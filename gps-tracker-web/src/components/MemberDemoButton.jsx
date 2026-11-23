import { Fragment, useState } from 'react';
import Modal from './ui/Modal';
import useBreakpoint from '../useBreakpoint';
import './member-demo-button.css';

export default function MemberDemoButton({path = 'demo'}) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return <>
    <button type="button" className="member-demo-trigger" aria-label="데모 체험 안내" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>체험</button>
    <Modal open={open} onClose={close} className="pt-standard-dialog" size={530} title="데모 체험 안내"
      footer={<div className="pt-dialog-actions">
        <button type="button" className="pt-button" onClick={close}>닫기</button>
        <a className="pt-button pt-primary" href={import.meta.env.BASE_URL + path} target="_blank" rel="noopener noreferrer" onClick={close}>새 탭에서 체험 열기</a>
      </div>}>
      <p className="member-demo-description">예시 차량과 운행 기록으로 메뉴와 업무 흐름을 살펴보세요. 체험 중 입력한 내용은 체험 탭에 저장됩니다.</p>
    </Modal>
  </>;
}

export function MemberHeaderActions({scope, widthControl, search, alerts, demoPath}) {
  const mobile = useBreakpoint() === 'mobile';
  const controls = {scope, widthControl, search, alerts, demo: demoPath && <MemberDemoButton path={demoPath}/>};
  const order = mobile
    ? ['widthControl', 'search', 'alerts', 'scope', 'demo']
    : ['scope', 'widthControl', 'search', 'demo', 'alerts'];
  return order.map(key => controls[key] && <Fragment key={key}>{controls[key]}</Fragment>);
}
