import CarImage from '../CarImage';
import Icon from '../Icon';
import { kstDateTime } from '../../lib/businessExport';
import { agreementTotal } from '../../lib/rentalWorkflow';
import { won } from '../../lib/rentalOffice';
import { agreedPrice, isAssigned } from '../../lib/rentalInventory';
import { SettlementSummary } from '../RentcarPanel';
import RentalRecordDrawer, { RecordFields } from './RentalRecordDrawer';
import { StageBadge } from './RentalStageTable';
import { AgreementDetail } from './RentalAgreementActions';
import RentalContractHistory from './RentalContractHistory';

export const carLabel = c => c.license_plate || c.device_name || (isAssigned(c) ? '차량 '+(c.vehicle_id ?? c.device_id) : '차량 미배정');
export const templateText = c => (c.rental_terms?.template_body || '').replaceAll('{{고객연락처}}',c.renter_phone || '—');

export function driverLabel(contract) {
  const terms=contract.rental_terms||{};
  if(terms.driver_name)return terms.driver_name;
  return terms.driver_id!=null&&String(terms.driver_id)!==String(terms.customer_id)?'미등록':contract.renter_name;
}

export function ContractTerms({contract,onClose}) {
  return <RentalRecordDrawer title="계약 내용" subtitle={'예약 R-'+contract.id} onClose={onClose}>
    <p className="rental-record-text">{templateText(contract)||'이 계약에 등록된 계약서 내용이 없습니다.'}</p>
  </RentalRecordDrawer>;
}

export default function RentalContractDetails({contract,now,assignedVehicle,links,inspectionLinks,reconfirm=false}) {
  const recipient=driverLabel(contract);
  return <div className="rental-detail"><div className="rental-detail-top">
        <div className="rental-contract-car"><span aria-hidden="true"><CarImage deviceId={assignedVehicle?.device_id} version={assignedVehicle?.device_id&&assignedVehicle.car_image_url} fallback={<Icon name="car" size={24}/>}/></span>
          <div><h3>{carLabel(contract)}</h3>{(assignedVehicle?.car_model||contract.rental_terms?.requested_model)&&<small>{assignedVehicle?.car_model||contract.rental_terms.requested_model}</small>}</div>
        </div><StageBadge contract={contract} now={now}/></div>
        <RecordFields rows={[['계약 고객',contract.renter_name],['실운전자',recipient],['운전자 면허',contract.rental_terms?.license_checked?'확인 완료':'확인 전'],
          ['인수 예정',kstDateTime(contract.starts_at)],['반납 예정',kstDateTime(contract.ends_at)],['인수 / 반납 지점',(contract.pickup_location || '미지정')+' / '+(contract.return_location || '미지정')],
          ['계약 확인',contract.rental_terms?.confirmed_at?kstDateTime(contract.rental_terms.confirmed_at):'확인 전']]}/>
        {links}
        {agreedPrice(contract) && <AgreementDetail contract={contract}/>}
        <section><h3>대여료와 보증금</h3><RecordFields rows={[['약정 대여료',won(agreementTotal(contract))],['약정 보증금',won(contract.deposit_krw)]]}/></section>
        <section><h3>인도·반납 점검</h3>
          {contract.pickup_odometer_km!=null && <p>{contract.pickup_odometer_km.toLocaleString()} km {contract.rental_terms?.pickup_fuel!=null?' · 연료·충전량 '+contract.rental_terms.pickup_fuel+'%':''}</p>}
          {contract.rental_terms?.pickup_note && <p>{contract.rental_terms.pickup_note}</p>}
          {inspectionLinks}
        </section>
        {contract.status==='returned' && (!agreedPrice(contract) || contract.settled_at) && <section><h3>반납 정산</h3><SettlementSummary c={contract}/></section>}
        {contract.status==='cancelled' && contract.rental_terms?.cancel_outcome && <section><h3>{contract.rental_terms.cancel_outcome==='no_show'?'미방문':'예약 취소'} 처리</h3>
          <dl><div><dt>취소 수수료</dt><dd>{won(contract.rental_terms.cancellation_fee_krw)}</dd></div>
            <div><dt>처리 사유</dt><dd>{contract.rental_terms.cancel_reason}</dd></div>
            <div><dt>처리 일시</dt><dd>{kstDateTime(contract.rental_terms.cancelled_at)}</dd></div></dl></section>}
        {reconfirm && !contract.rental_terms?.confirmed_at && <p role="status">예약이 변경됐습니다. 계약 조건을 다시 확인해 주세요.</p>}
        <section><h3>메모</h3><p className="rental-record-text">{contract.note||'등록된 메모가 없습니다.'}</p></section>
        <section><h3>처리 이력</h3><RentalContractHistory key={contract.id} contractId={contract.id}/></section>
      </div>;
}
