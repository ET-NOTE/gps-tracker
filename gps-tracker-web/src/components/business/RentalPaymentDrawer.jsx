import {useState} from 'react';
import {Button} from '../ui';
import {entryKinds, methods, readTime, recordLimit, won} from '../../lib/rentalOffice';
import {agreedPrice} from '../../lib/rentalInventory';
import {BusinessError} from './BusinessWorkspace';
import {HistoryContract,useRentalContractDetail} from './RentalCustomerHistory';
import RentalRecordDrawer, {RecordFields} from './RentalRecordDrawer';

export function RentalEntryDrawer({entry,onClose,onContract}) {
  return <RentalRecordDrawer title="거래 기록 상세" subtitle={entryKinds[entry.kind]+' · '+won(entry.amount_krw)} onClose={onClose}
    footer={<Button variant="primary" onClick={onContract}>계약 결제 내역</Button>}>
    <RecordFields rows={[
      ['계약번호','#'+entry.contract_id],['고객',entry.renter_name],['기록 구분',entryKinds[entry.kind]],
      ['금액',won(entry.amount_krw)],['거래 수단',methods[entry.method]],['거래 일시',readTime(entry.recorded_at)],
      ['금액 구분',entry.kind.startsWith('deposit_')?'보증금':'이용료'],
    ]}/>
    <section><h3>기록 메모</h3><p className="rental-record-text">{entry.memo||'등록된 메모가 없습니다.'}</p></section>
  </RentalRecordDrawer>;
}

export default function RentalPaymentDrawer({contract,entries,onClose,onRecord,onEntry}) {
  const [showContract,setShowContract]=useState(false);
  const rental=useRentalContractDetail(contract.id);
  const price=agreedPrice(rental.data);
  const balance=contract.billed_krw-contract.paid_krw;
  const status=contract.cancel_outcome==='no_show'?'미방문':contract.settlement_finalized?'정산 완료':
    ({draft:'예약 접수',active:'대여 중',overdue:'반납 지연',returned:'반납 완료',cancelled:'취소'})[contract.status];
  function entryButton(kind,label,primary=false) {
    return <Button variant={primary?'primary':'ghost'} size="sm" disabled={recordLimit(contract,kind)<=0}
      onClick={()=>onRecord({contract,kind})}>{label}</Button>;
  }
  return <RentalRecordDrawer title="청구·결제 기록" subtitle={'#'+contract.id+' · '+contract.renter_name} onClose={onClose}
    footer={<Button onClick={()=>setShowContract(true)}>계약 상세</Button>}>
    <div className="rental-payment-status"><span className="ro-status">{status}</span>
      <span className={'ro-status'+(balance>0?' amber':'')}>{balance<0?'초과 수납':balance>0?'미수금 있음':'미수금 없음'}</span></div>
    <section className="rental-money-block"><h3>이용료</h3>
    {rental.isError&&<BusinessError onRetry={rental.refetch}>계약의 요금 구성을 불러오지 못했습니다.</BusinessError>}
    <RecordFields rows={[
      ...(price?[['기본 대여요금',won(price.base_krw)],['자차·옵션',won(price.option_krw||0)],
        ['추가요금',won((price.extension_krw||0)+(price.return_extra_krw||0))],['할인',won(price.discount_krw||0)]]:[]),
      ...(contract.cancellation_fee_krw!=null?[['취소·미방문 수수료',won(contract.cancellation_fee_krw)]]:[]),
      ['현재 청구액',won(contract.billed_krw)],['순수납액',won(contract.paid_krw)],
      ['미수금',won(Math.max(0,balance))],['초과수납액',won(Math.max(0,-balance))],
    ]}/><div className="ro-actions">{entryButton('payment','수납 기록',true)}{entryButton('refund','환불 기록')}</div></section>
    <section className="rental-money-block"><h3>보증금</h3><RecordFields rows={[
      ['약정 보증금',won(contract.deposit_krw)],['현재 보유액',won(contract.held_krw)],
      ['추가 수납 가능',won(recordLimit(contract,'deposit_in'))],
    ]}/><div className="ro-actions">{entryButton('deposit_in','보증금 수납 기록')}{entryButton('deposit_out','보증금 반환 기록')}</div></section>
    <section><h3>조회 기간의 거래 · {entries.length}건</h3>{entries.length?entries.map(entry=>
      <button key={entry.id} type="button" className="rental-record-related" onClick={()=>onEntry(entry)}>
        <span>{entryKinds[entry.kind]} · {won(entry.amount_krw)}</span><small>{readTime(entry.recorded_at)}</small>
      </button>):<p className="rental-record-text">조회 기간에 기록된 거래가 없습니다.</p>}</section>
    {showContract&&<HistoryContract id={contract.id} returnLabel="청구·결제 기록으로" onClose={()=>setShowContract(false)}/>}
  </RentalRecordDrawer>;
}
