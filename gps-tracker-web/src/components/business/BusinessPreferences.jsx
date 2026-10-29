import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { useCorporateInfo, qk } from '../../state';
import { Modal, FormField, Input, Button, SkeletonList } from '../ui';
import { BusinessSection, BusinessButton, BusinessError } from './BusinessWorkspace';
import { kstDateTime } from '../../lib/businessExport';
import Icon from '../Icon';

const fields = [['business_number', '사업자번호', '000-00-00000'], ['company_name', '상호 (회사명)', '회사명'], ['representative', '대표자', '대표자 이름'], ['address', '주소 (선택)', '사업장 주소']];
export function BusinessCompanyInfo({readOnly=false}) {
  const result = useCorporateInfo(), qc = useQueryClient(), [draft, setDraft] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), lock = useRef(false);
  const info = draft || result.data;
  const missing = fields.slice(0, 3).filter(([key]) => !String(info?.[key] || '').trim()).map(([, label]) => label);
  async function save() {
    if (lock.current || !info) return;
    lock.current = true; setBusy(true); setError(''); setSaved(false);
    try { const value = await api.putCorporateInfo(Object.fromEntries(fields.map(([key]) => [key, String(info[key] || '').trim() || null]))); qc.setQueryData(qk.corporateInfo(), value); setDraft(null); setSaved(true); }
    catch { setError('회사 정보를 저장하지 못했습니다. 입력 내용을 유지했습니다. 다시 시도해 주세요.'); }
    finally { lock.current = false; setBusy(false); }
  }
  if (result.error && !draft) return <BusinessError onRetry={result.refetch}>회사 정보를 불러오지 못했습니다.</BusinessError>;
  if (!info) return <SkeletonList count={3} itemHeight={70} />;
  return <div className="business-support">
    <BusinessSection title="회사 정보" description="운행기록부에 표시됩니다.">
      {missing.length > 0 && <p className="business-company-missing">미입력: {missing.join(' · ')}</p>}
      <div className="business-support-body"><div className="business-support-form">{fields.map(([key, label, placeholder]) => <FormField key={key} label={label}><Input value={info[key] || ''} onChange={e => { setSaved(false); setError(''); setDraft({ ...info, [key]: e.target.value }); }} disabled={busy||readOnly} placeholder={placeholder} /></FormField>)}</div>
        {error && <BusinessError>{error}</BusinessError>}{saved && <p role="status" className="business-support-success">회사 정보를 저장했습니다.</p>}
        <div className="business-support-actions"><span className="business-note">저장 후 보고서에 반영됩니다.</span>{!readOnly&&<Button busy={busy} onClick={save}>회사 정보 저장</Button>}</div>
      </div>
    </BusinessSection>
  </div>;
}

const features = {
  corporate: [['route', '운행 리포트', '차량·기간별 운행과 운전자·용무 기록'], ['bar', '월간 리포트', '운행 거리와 입력한 유류비 확인'], ['share', '보고서 내보내기', 'CSV·PDF·엑셀 및 인쇄'], ['user', '운전자 관리', '운전자 등록과 활성 상태 관리']],
  rentcar: [['route', '계약·반납 정산', '계약 이력, 정산 내역과 청구서 확인'], ['clock', '배차·반납 일정', '차량별 배차표와 반납 일정 확인'], ['user', '임차인 관리', '이용 이력과 계약 시 유의사항 확인'], ['cam', '인수·반납 기록', '인수·반납 링크 발급과 사진 기록']],
};
export function BusinessSubscription({ sub, onChange, kind = 'corporate', report = false, canBuy = true }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false), lock = useRef(false);
  const title = kind === 'rentcar' ? '렌트카 리포트 이용권' : '법인차 리포트 이용권';
  const validPrice = Number.isFinite(sub?.price_krw) && sub.price_krw >= 0;
  const days = sub?.expires_at && Number.isFinite(Date.parse(sub.expires_at)) ? Math.max(0, Math.ceil((Date.parse(sub.expires_at) - Date.now()) / 86400000)) : null;
  async function buy() {
    if (lock.current || !validPrice) return;
    lock.current = true; setBusy(true); setError('');
    try { const next = await (kind === 'rentcar' ? api.buyRentcarSubscription() : api.buyCorporateSubscription()); onChange(next); setConfirm(false); setSaved(true); }
    catch (e) { setError(e.message || '이용권을 결제하지 못했습니다. 다시 시도해 주세요.'); }
    finally { lock.current = false; setBusy(false); }
  }
  if (!sub) return <SkeletonList count={2} itemHeight={100} />;
  return <div className={`business-support${report ? ' business-report-access' : ''}`}>
    <BusinessSection title={title} description={report ? '차량별 운행과 월간 요약' : undefined} action={<span className={`business-badge ${sub.active ? 'good' : 'info'}`}>{sub.active ? '이용 중' : '이용권 필요'}</span>}>
      <div className="business-support-body"><dl className="business-support-summary">{report ? <div><dt>이용 기간</dt><dd>결제일부터 30일</dd></div> : <><div><dt>이용 종료</dt><dd>{sub.expires_at ? kstDateTime(sub.expires_at) : '이용 내역 없음'}</dd></div><div><dt>남은 기간</dt><dd>{sub.active && days != null ? `${days}일` : '—'}</dd></div></>}<div><dt>30일 이용 금액</dt><dd className="business-subscription-price">{validPrice ? `${sub.price_krw.toLocaleString()}원` : '금액 확인 필요'}</dd></div></dl>
        <p className="business-note">포인트로 결제하며 30일씩 추가됩니다. 법인차와 렌트카 이용권은 각각 관리됩니다.</p>
        {saved && <p className="business-support-success" role="status">이용권 결제가 완료되었습니다. 변경된 이용 종료 시각을 확인해 주세요.</p>}
        <div className="business-support-actions"><span className="business-note">{canBuy?'포인트가 부족하면 내정보 → 포인트에서 충전을 요청하세요.':'이용권 결제는 회사 소유자에게 요청해 주세요.'}</span><BusinessButton primary disabled={!canBuy || !validPrice || busy} onClick={() => { setError(''); setConfirm(true); }}>{sub.active ? '30일 연장' : '30일 이용 시작'}</BusinessButton></div>
      </div>
    </BusinessSection>
    <BusinessSection title={report ? '리포트에서 할 수 있는 일' : '제공 기능'}><div className="business-feature-grid">{(report ? features[kind].slice(0, 3) : features[kind]).map(([icon, label, text]) => <div key={label}><span className="business-feature-icon"><Icon name={icon} size={20} /></span><div><strong>{label}</strong><p>{text}</p></div></div>)}</div></BusinessSection>
    {confirm && <Modal open title="이용권 결제 확인" subtitle={title} onClose={busy ? undefined : () => setConfirm(false)} closeOnBackdrop={false} closeOnEsc={!busy} footer={<><Button className="business-form-cancel" variant="ghost" disabled={busy} onClick={() => setConfirm(false)}>취소</Button><Button className="business-form-submit" busy={busy} onClick={buy}>포인트로 결제</Button></>}>
      <dl className="business-support-summary"><div><dt>이용 기간</dt><dd>30일 추가</dd></div><div><dt>결제 금액</dt><dd>{sub.price_krw.toLocaleString()}원</dd></div></dl><p className="business-support-message">확인하면 보유 포인트에서 차감됩니다.</p>{error && <BusinessError>{error}</BusinessError>}
    </Modal>}
  </div>;
}
