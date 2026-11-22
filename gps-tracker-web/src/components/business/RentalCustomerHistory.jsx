import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { kstDateTime } from '../../lib/businessExport';
import { StageBadge } from './RentalStageTable';
import { Modal } from '../ui';
import { BusinessButton, BusinessError } from './BusinessWorkspace';
import RentalRecordDrawer from './RentalRecordDrawer';
import RentalContractDetails, { ContractTerms } from './RentalContractDetails';
import { ContractPhotos } from './RentalPhotos';
import { useBusinessClock } from './useBusinessData';

const roles = {customer:'계약 고객', driver:'실운전자', both:'계약 고객 · 실운전자'};

export function useRentalContractDetail(id) {
  return useQuery({
    queryKey:[authScope(),'rental-contract-detail',id],
    queryFn:({signal})=>api.getRentalContract(id,signal),
    gcTime:0, retry:false,
  });
}
export function HistoryContract({id,onClose,returnLabel='대여 이력으로'}) {
  const now=useBusinessClock();
  const [section,setSection]=useState(null);
  const contract=useRentalContractDetail(id);
  return <RentalRecordDrawer title="대여 계약 상세" subtitle={'예약 R-'+id} onClose={onClose}
    footer={<BusinessButton onClick={onClose}>{returnLabel}</BusinessButton>}>
    {contract.isError?<BusinessError onRetry={contract.refetch}>계약 상세를 불러오지 못했습니다.</BusinessError>
      :contract.isPending?<p role="status">계약을 불러오는 중…</p>
      :<RentalContractDetails contract={contract.data} now={now}
        links={<div className="rental-record-links"><BusinessButton icon="file" onClick={()=>setSection('terms')}>계약 내용</BusinessButton></div>}
        inspectionLinks={<div className="rental-record-links"><BusinessButton onClick={()=>setSection('photos')}>인수·반납 사진</BusinessButton></div>}/>}
    {contract.isSuccess&&section==='terms'&&<ContractTerms contract={contract.data} onClose={()=>setSection(null)}/>}
    {contract.isSuccess&&section==='photos'&&<Modal open size="lg" title="계약 사진" subtitle={'예약 R-'+id} onClose={()=>setSection(null)}>
      <ContractPhotos contractId={id}/>
    </Modal>}
  </RentalRecordDrawer>;
}

export default function RentalCustomerHistory({customerId}) {
  const [selectedId,setSelectedId]=useState(null);
  const query=useInfiniteQuery({
    queryKey:[authScope(),'rental-customer-contracts',customerId],
    queryFn:({pageParam,signal})=>api.rentalCustomerContracts(customerId,pageParam,signal),
    initialPageParam:null, getNextPageParam:last=>last.next_cursor??undefined,
    gcTime:0,retry:false,
  });
  const denied=[403,404].includes(query.error?.status);
  const failed=query.isError&&(!query.isFetchNextPageError||denied);
  const pages=failed?[]:query.data?.pages||[];
  const rows=[...new Map(pages.flatMap(page=>page.items.map(item=>[item.id,item]))).values()];
  const total=pages[0]?.total;
  return <section className="rental-customer-history" aria-label="대여 이력">
    <h3>대여 이력{total!=null&&' · '+total.toLocaleString('ko-KR')+'건'}</h3>
    {failed?<BusinessError onRetry={query.refetch}>대여 이력을 불러오지 못했습니다.</BusinessError>
      :query.isPending?<p role="status">대여 이력을 불러오는 중…</p>
      :rows.length?<ul>{rows.map(row=><li key={row.id}>
        <button type="button" className="rental-record-related" onClick={()=>setSelectedId(row.id)} aria-haspopup="dialog">
          <span><strong>R-{row.id} · {row.license_plate||row.vehicle_name||row.requested_model||'차량 미배정'}</strong>
            <small>{kstDateTime(row.starts_at)} ~ {kstDateTime(row.ends_at)}</small>
            <small>{roles[row.role]}{row.role==='driver'&&row.renter_name?' · 계약 고객 '+row.renter_name:''}{row.role==='customer'&&row.driver_name?' · 실운전자 '+row.driver_name:''}</small></span>
          <StageBadge contract={row} summary/>
        </button>
      </li>)}</ul>:<p>등록된 대여 이력이 없습니다.</p>}
    {!failed&&query.isFetchNextPageError&&<p role="alert">다음 이력을 불러오지 못했습니다.</p>}
    {!failed&&query.hasNextPage&&<BusinessButton disabled={query.isFetchingNextPage} onClick={()=>query.fetchNextPage({cancelRefetch:false})}>
      {query.isFetchingNextPage?'불러오는 중…':query.isFetchNextPageError?'다시 시도':'더 보기'}</BusinessButton>}
    {!denied&&selectedId!=null&&<HistoryContract key={selectedId} id={selectedId} onClose={()=>setSelectedId(null)}/>}
  </section>;
}
