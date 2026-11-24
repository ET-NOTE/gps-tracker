import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { BusinessButton, BusinessError } from './BusinessWorkspace';
import useCorporatePhone from '../../useCorporatePhone';
import { hideOutsideMockup } from '../../lib/mockupHidden';

export const policyKey = () => [authScope(), 'rentcar', 'operating-policy'];
const checks = [
  ['require_license','운전면허 확인을 완료해야 출고할 수 있습니다.'],
  ['require_contract','계약 확인을 완료해야 출고할 수 있습니다.'],
  ['require_payment','대여요금 전액 수납 후 출고할 수 있습니다.'],
];
// Desktop design order: license, payment, then contract.
const mockupChecks = [checks[0], checks[2], checks[1]];

function PolicyForm({policy}) {
  const qc = useQueryClient();
  const [form,setForm] = useState(policy);
  const [saving,setSaving] = useState(false), [error,setError] = useState(''), [saved,setSaved] = useState(false);
  function field(name,value) {setForm(previous=>({...previous,[name]:value}));setSaved(false);setError('');}
  async function save(event) {
    event.preventDefault();
    if(saving)return;
    setSaving(true);setError('');
    try {
      const response = await api.saveRentalOperatingPolicy({...form,buffer_minutes:Number(form.buffer_minutes),late_hourly:form.late_hourly===''||form.late_hourly==null?null:Number(form.late_hourly)});
      qc.setQueryData(policyKey(),response);setForm(response);setSaved(true);
    } catch(e) {setError(e.message || '정책을 저장하지 못했습니다.');}
    finally {setSaving(false);}
  }
  const mockup = !useCorporatePhone() && hideOutsideMockup;
  const status = <>{error&&<span role="alert">{error}</span>}{saved&&<span role="status">대여 정책을 저장했습니다.</span>}</>;
  const bookingSection = <section><h2>예약·반납</h2>
      <label>예약 사이 준비 시간 (분)<input type="number" min="0" max="1440" step="1" required value={form.buffer_minutes} onChange={e=>field('buffer_minutes',e.target.value)}/><small>차량 점검·세차를 위한 예약 간격입니다.</small></label>
      <label>시간당 지연 요금 (원)<input type="number" min="0" max="10000000" step="1" placeholder="기존 요금 계산식 사용" value={form.late_hourly??''} onChange={e=>field('late_hourly',e.target.value)}/></label>
      <label className="rnt-check"><input type="checkbox" checked={form.notify_return} onChange={e=>field('notify_return',e.target.checked)}/>반납 예정 알림을 표시합니다.</label>
    </section>;
  const depositNote = <p className="rnt-policy-note">보증금은 대여요금과 별도로 관리합니다.</p>;
  if (mockup) return <form className="rnt-policy" data-mockup="true" onSubmit={save}>
    <div className="rnt-policy-toolbar"><p className="rnt-policy-note">저장한 조건은 이후 예약 가능 여부와 출고 확인에 적용됩니다.</p>
      <div>{status}<BusinessButton type="submit" primary icon="check" disabled={saving}>{saving?'저장 중…':'정책 저장'}</BusinessButton></div></div>
    {bookingSection}
    <section><h2>출고 전 확인</h2>{mockupChecks.map(([name,label])=><label key={name} className="rnt-check"><input type="checkbox" checked={form[name]} onChange={e=>field(name,e.target.checked)}/>{label}</label>)}{depositNote}</section>
  </form>;
  return <form className="rnt-policy" onSubmit={save}>
    <p className="rnt-policy-note">저장한 조건은 이후 예약 가능 여부와 출고 확인에 적용됩니다.</p>
    {bookingSection}
    <section><h2>출고 전 확인</h2>{checks.map(([name,label])=><label key={name} className="rnt-check"><input type="checkbox" checked={form[name]} onChange={e=>field(name,e.target.checked)}/>{label}</label>)}</section>
    {depositNote}
    <footer>{status}<button className="business-button is-primary" disabled={saving}>{saving?'저장 중…':'정책 저장'}</button></footer>
  </form>;
}
export default function RentalPolicy() {
  const query=useQuery({queryKey:policyKey(),queryFn:api.rentalOperatingPolicy});
  if(query.isPending)return <p role="status">정책을 불러오는 중…</p>;
  if(query.error)return <BusinessError onRetry={query.refetch}>대여 정책을 불러오지 못했습니다.</BusinessError>;
  return <PolicyForm policy={query.data}/>;
}
