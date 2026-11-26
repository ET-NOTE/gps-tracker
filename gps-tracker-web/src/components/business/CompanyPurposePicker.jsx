import React from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../../api';
import {BusinessError} from './BusinessWorkspace';
import {FormField,Select} from '../ui';

export function usePurposes() {
  return useQuery({queryKey:['fleet-trip-purposes'], queryFn:() => api.fleetTripPurposes()});
}

export default function CompanyPurposePicker({value,onChange,initialId,initialName,label='회사 운행 목적'}) {
  const request = usePurposes();
  const options = (request.data || []).filter(p => p.active || p.id === initialId);
  if (request.error) return <BusinessError onRetry={request.refetch}>{initialName ? `현재 운행 목적 · ${initialName}. ` : ''}회사 운행 목적을 불러오지 못했습니다.</BusinessError>;
  if (request.isPending || (!options.length && !initialId)) return null;
  return <FormField label={label}>
    <Select aria-label={label} value={value} onChange={e=>onChange(e.target.value)}>
      <option value="">미지정</option>
      {options.map(p=><option key={p.id} value={p.id}>{p.name}{p.active?'':' (사용 중지)'}</option>)}
    </Select>
  </FormField>;
}
