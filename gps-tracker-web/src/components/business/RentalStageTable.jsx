import CarImage from '../CarImage';
import Icon from '../Icon';
import { kstDateTime } from '../../lib/businessExport';
import { agreementTotal, workflowStatus } from '../../lib/rentalWorkflow';
import { agreedPrice, isAssigned } from '../../lib/rentalInventory';
import { won } from '../../lib/rentalOffice';
import { BusinessButton } from './BusinessWorkspace';

const statusTone = {'예약':'blue','배차 대기':'amber','예약 접수':'blue','출고 준비':'blue','대여 중':'green','반납 지연':'red','반납 완료':'amber','미방문':'amber'};
export function StageBadge({contract, now, summary=false}) {
  const state = summary&&contract.status==='draft'?'예약':workflowStatus(contract,now);
  return <span className={'rental-status '+(statusTone[state] || '')}>{state}</span>;
}

const columns = {
  reservations:['예약번호','고객','차량 / 차종','이용 기간','청구액','진행 상태','결제 상태'],
  dispatch:['예약번호','고객','차량 / 차종','이용 기간','인수 지점','진행 상태','배차'],
  contracts:['계약번호','계약 고객 / 실운전자','차량','이용 기간','계약 확인','청구액 / 미수금','상태'],
  checkout:['예약번호','고객 / 실운전자','배정 차량','인수 예정','확인할 항목','대여료','출고'],
  active:['계약번호','고객','차량','실제 인도 / 반납 예정','반납 지점','결제 상태','업무 처리'],
  returns:['계약번호','고객','차량','반납 예정 / 실제','진행 상태','대여료 / 보관 보증금','업무 처리'],
};
function PaymentBadge({balance}) {
  if (!balance) return <span>—</span>;
  const due = Math.max(0,balance.billed_krw-balance.paid_krw);
  const label = balance.billed_krw===0 && balance.paid_krw===0 ? '청구 없음' : due === 0 ? '수납 완료' : balance.paid_krw > 0 ? '부분 수납' : '수납 전';
  return <span className={'rental-status '+(due?'amber':'green')}>{label}</span>;
}

export default function RentalStageTable({stage, rows, now, balances, devices, checksFor, onDetail, onAction}) {
  function cells(c) {
    const name=c.license_plate || c.device_name || '차량 미배정', balance=balances.get(c.id);
    const vehicle=devices.find(d=>d.id===c.device_id);
    const vehicleCell=<span className="rental-row-car">{vehicle && <CarImage deviceId={vehicle.id} version={vehicle.car_image_url} fallback={<Icon name="car" size={22}/>}/>}<span>{name}<small>{c.rental_terms?.requested_model}</small></span></span>;
    const head=[<><button className="rental-record-link" onClick={()=>onDetail(c)}>R-{c.id}</button><small>{c.rental_terms?.channel}</small></>,
      <>{c.renter_name}<small>{c.rental_terms?.driver_name && c.rental_terms.driver_name!==c.renter_name ? '운전자 '+c.rental_terms.driver_name : c.renter_phone}</small></>, vehicleCell];
    const period=<>{kstDateTime(c.starts_at)}<small>~ {kstDateTime(c.ends_at)}</small></>;
    const badge=<StageBadge contract={c} now={now}/>, payment=<PaymentBadge balance={balance}/>;
    const bill=won(balance?.billed_krw ?? (c.status==='cancelled' ? c.rental_terms?.cancellation_fee_krw ?? 0 : agreementTotal(c)));
    const button=(label,kind)=><BusinessButton onClick={()=>kind?onAction(kind,c):onDetail(c)}>{label}</BusinessButton>;
    if (stage==='contracts') return [...head,period,c.rental_terms?.confirmed_at?'확인 완료':'확인 전',<>{bill}<small>{balance ? '미수 '+won(Math.max(0,balance.billed_krw-balance.paid_krw)) : '미수금 확인 전'}</small></>,badge];
    if (stage==='dispatch') return [...head,period,c.pickup_location || '—',badge,button(c.status==='draft'?'차량 배정':'상세',c.status==='draft'?'edit':null)];
    if (stage==='checkout') {
      const checks=checksFor(c);
      return [...head,kstDateTime(c.starts_at),checks==null?'확인 중':checks.length ? checks.join(' · ') : '사전 확인 완료',bill,
        button(c.rental_terms && isAssigned(c)?'출고 점검':'상세',c.rental_terms && isAssigned(c)?'checkout':null)];
    }
    if (stage==='active') return [...head,<>{kstDateTime(c.rental_terms?.checkout_at || c.starts_at)}<small>~ {kstDateTime(c.ends_at)}</small></>,
      c.return_location || '—', payment,button('반납 접수','return')];
    if (stage==='returns') return [...head,<>{kstDateTime(c.ends_at)}<small>{c.returned_at?kstDateTime(c.returned_at):'반납 대기'}</small></>,badge,
      <>{bill}<small>{balance ? '보증금 '+won(balance.held_krw):'보증금 확인 전'}</small></>,button(c.status==='returned'?(agreedPrice(c) && !c.settled_at?'대여료 정산':'정산 확인'):'반납 접수',c.status==='returned'?(agreedPrice(c) && !c.settled_at?'settle':null):'return')];
    return [...head,period,bill,badge,payment];
  }
  return <div className="rental-stage-table" role="region" aria-label={columns[stage][0]+'별 목록'} tabIndex={0}>
    <table><thead><tr>{columns[stage].map(label=><th scope="col" key={label}>{label}</th>)}</tr></thead>
      <tbody>{rows.length ? rows.map(c=><tr key={c.id} onClick={event=>{
        if (event.target.closest('button,a')) return;
        event.currentTarget.querySelector('.rental-record-link')?.focus({preventScroll:true});
        onDetail(c);
      }}>{cells(c).map((value,index)=><td key={index}>{value}</td>)}</tr>) :
        <tr><td className="rental-list-empty" colSpan={columns[stage].length}>조건에 맞는 대여 내역이 없습니다.</td></tr>}</tbody>
    </table>
  </div>;
}
