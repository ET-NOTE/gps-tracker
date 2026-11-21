// Isolated browser preview. All records live for the lifetime of this page only.
import { agreedPrice, priceTotal } from '../src/lib/rentalInventory.js';
import { matchOfficeCustomer } from '../src/lib/rentalOffice.js';
export function installRentalOfficeFixture(api, { rentals, devices, empty, failed, day }) {
  const catalog = {
    customers:empty?[]:[{id:1,revision:1,active:true,name:'운영 고객',kind:'person',phone:'010-0000-0001',email:'',license_checked:true,license_type:'2종 보통'}],
    accounts:empty?[]:[{id:2,revision:1,active:true,name:'운영 거래처',phone:'02-0000-0000',contact:'담당자',billing:'monthly'}],
    rates:empty?[]:[{id:3,revision:1,active:true,name:'중형',daily_krw:70000,deposit_krw:100000,coverage_krw:12000}],
    templates:empty?[]:[{id:4,revision:1,active:true,name:'기본 대여 계약서',body:'{{회사명}} 대여 계약서\n\n계약번호 {{계약번호}}\n고객 {{고객명}}\n대여 {{대여시작}} ~ {{반납예정}}'}],
  };
  const first=rentals[0];
  const entries=first&&!empty?[{id:1,contract_id:first.id,device_id:first.device_id,renter_name:first.renter_name,
    kind:'payment',method:'card',amount_krw:50000,recorded_at:day+'T09:00:00+09:00',day,memo:''}]:[];
  const costs=first&&!empty?[{id:2,device_id:first.device_id,vehicle_name:first.license_plate,occurred_on:day,
    category:'wash',amount_krw:8000,vendor:'검수 세차장',memo:'',revision:1}]:[];
  let serial=10;
  function totals(id) {
    const cons=entries.filter(e=>e.contract_id===id);
    return cons.reduce((v,e)=>{
      if (e.kind==='payment'||e.kind==='refund') v.paid_krw+=e.amount_krw*(e.kind==='refund'?-1:1);
      else v.held_krw+=e.amount_krw*(e.kind==='deposit_out'?-1:1);
      return v;
    },{paid_krw:0,held_krw:0});
  }
  const billed=c=>c.status==='cancelled' ? c.rental_terms?.cancellation_fee_krw??0 : agreedPrice(c)?priceTotal(agreedPrice(c)):c.settled_amount_krw??c.rate_amount_krw;
  api.rentalBalance=async id=>{const c=rentals.find(r=>r.id===id);return {...totals(id),billed_krw:billed(c),extensions:[]};};
  function customerContracts(id) {
    const rows=[];
    for(const contract of rentals) {
      const terms=contract.rental_terms||{};
      const customer=matchOfficeCustomer({customer_id:terms.customer_id,renter_phone:contract.renter_phone},catalog)?.id===id;
      const driver=terms.driver_id===id;
      if(customer||driver)rows.push({...contract,driver_name:terms.driver_name,requested_model:terms.requested_model,vehicle_name:contract.device_name,role:driver?(customer?'both':'driver'):'customer'});
    }
    return rows.sort((a,b)=>Date.parse(b.starts_at)-Date.parse(a.starts_at)||b.id-a.id);
  }
  api.rentalCustomerContracts=async(id,cursor)=>{
    if(failed)throw Error('대여 이력 조회 실패');
    const rows=customerContracts(id),start=Number(cursor)||0;
    return {total:rows.length,items:rows.slice(start,start+10),next_cursor:start+10<rows.length?String(start+10):null};
  };
  api.getRentalContract=async id=>{
    const row=rentals.find(contract=>contract.id===id);
    if(failed||!row)throw Error('계약 상세 조회 실패');
    return structuredClone(row);
  };
  api.rentalOffice=async(method,route,body)=>{
    if(failed)throw Error('렌트카 정보 조회 실패');
    if(route==='/catalog')return structuredClone(catalog);
    if(route==='/catalog?summary=true')return structuredClone({...catalog,customers:catalog.customers.map(c=>({...c,contracts_count:customerContracts(c.id).length}))});
    if(route.startsWith('/catalog/')){
      const [, ,kind,id]=route.split('/');
      const current=id&&catalog[kind].find(c=>c.id===Number(id));
      if(id&&!current)throw Error('항목을 찾을 수 없습니다.');
      if(current)Object.assign(current,body,{revision:current.revision+1});
      else catalog[kind].push({...body,id:++serial,revision:1});
      return {id:current?.id||serial};
    }
    if(route.startsWith('/book?')){
      const p=new URLSearchParams(route.split('?')[1]);
      const inRange=value=>value>=p.get('from')&&value<=p.get('to');
      const contracts=rentals.map(c=>({...c,vehicle_name:c.license_plate||c.device_name,
        cancel_outcome:c.rental_terms?.cancel_outcome,cancellation_fee_krw:c.rental_terms?.cancellation_fee_krw,
        settlement_finalized:!!agreedPrice(c) && !!c.settled_at,billed_krw:billed(c),...totals(c.id)}));
      return structuredClone({company_name:'시리얼링크',contracts,entries:entries.filter(e=>inRange(e.day)),costs:costs.filter(c=>inRange(c.occurred_on))});
    }
    if(route==='/ledger'){
      const c=rentals.find(c=>c.id===body.contract_id);
      if(!c)throw Error('계약을 찾을 수 없습니다.');
      entries.unshift({...body,id:++serial,renter_name:c.renter_name,vehicle_id:c.vehicle_id,device_id:c.device_id,day:new Date(new Date(body.recorded_at).getTime()+9*3600000).toISOString().slice(0,10)});
      return {id:serial};
    }
    if(route.startsWith('/costs')){
      const d=devices.find(d=>d.id===body.device_id),id=Number(route.split('/')[2]);
      const row={...body,vehicle_name:d?.license_plate||d?.car_plate||d?.display_name,occurred_on:body.occurred_on||day};
      if(id)Object.assign(costs.find(c=>c.id===id),row);
      else costs.unshift({...row,id:++serial,revision:1});
      return {id:id||serial};
    }
    throw Error('지원하지 않는 미리보기 요청입니다.');
  };
}
