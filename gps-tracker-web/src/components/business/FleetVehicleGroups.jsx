import {useState} from 'react';
import {useQuery,useMutation,useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {Modal,FormField,Input,Button} from '../ui';

const groupKey = ['business','corporate','vehicle-groups'];
export function useVehicleGroups(enabled=true) {
  return useQuery({queryKey:groupKey, queryFn:api.fleetVehicleGroups, enabled, staleTime:60000});
}
export function VehicleGroupForm({onClose,onCreated}) {
  const [name,setName]=useState('');
  const qc=useQueryClient();
  const create=useMutation({
    mutationFn:api.createFleetVehicleGroup,
    onSuccess: saved=>{
      qc.setQueryData(groupKey, previous=>[...(previous || []).filter(group=>group.id!==saved.id),saved].sort((a,b)=>a.name.localeCompare(b.name,'ko')));
      qc.invalidateQueries({queryKey:groupKey});
      onCreated(saved);
    }
  });
  return <Modal open title="차량 그룹 추가" size="sm" onClose={create.isPending?undefined:onClose}>
    <form className="fleet-group-form" onSubmit={event=>{event.preventDefault();if(name.trim()&&!create.isPending)create.mutate(name.trim());}}>
      <FormField label="그룹 이름"><Input autoFocus required maxLength={50} value={name} onChange={event=>setName(event.target.value)} placeholder="예: 영업차량"/></FormField>
      {create.error&&<p role="alert" className="business-error">{create.error.message}</p>}
      <div className="business-dialog-actions"><Button type="button" variant="ghost" disabled={create.isPending} onClick={onClose}>취소</Button><Button type="submit" busy={create.isPending} disabled={!name.trim()}>그룹 추가</Button></div>
    </form>
  </Modal>;
}
