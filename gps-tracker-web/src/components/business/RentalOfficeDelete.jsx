import {useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import Icon from '../Icon';
import {Button,toast} from '../ui';
import {costKinds,won} from '../../lib/rentalOffice';
import {FormModal} from './RentalOfficeKit';
import {officeBookKey,officeCatalogKey} from './rentalOfficeKeys';

export default function RentalOfficeDelete({kind,row,onDeleted}) {
  const qc=useQueryClient();
  const [target,setTarget]=useState(null);
  const [issue,setIssue]=useState('');
  const isTemplate=kind==='templates';
  const queryKey=isTemplate?officeCatalogKey():officeBookKey();

  function ask() {
    if (isTemplate && row.in_use) {
      setIssue('계약에 연결된 양식은 삭제할 수 없습니다.');
      return;
    }
    setIssue('');
    setTarget(row);
  }

  async function remove() {
    try {
      await api.rentalOffice('DELETE','/'+kind+'/'+target.id,{revision:target.revision});
    } catch (error) {
      if (error.status===404 || error.status===409) {
        setTarget(null);
        if(error.status===404){onDeleted();toast.error(error.message);}
        else setIssue(error.message);
        await qc.invalidateQueries({queryKey});
        return;
      }
      throw error;
    }
    onDeleted();
    qc.setQueriesData({queryKey},data=>data && {...data,[kind]:data[kind].filter(item=>item.id!==target.id)});
    toast.success(isTemplate?'양식을 삭제했습니다.':'운영비를 삭제했습니다.');
    await qc.invalidateQueries({queryKey});
  }

  return <>
    {issue&&<p className="ro-delete-notice" role="alert">{issue}</p>}
    <Button variant="ghost" style={{borderColor:'transparent'}} icon={<Icon name="trash" size={15}/>} onClick={ask}>삭제</Button>
    {target && <FormModal title={isTemplate?'계약서 양식을 삭제할까요?':'운영비를 삭제할까요?'} size={530} submitLabel="삭제"
      onClose={()=>setTarget(null)} save={remove}>
      <p className="ro-wide ro-delete-copy">{isTemplate?target.name+' 양식을 삭제합니다.':costKinds[target.category]+' '+won(target.amount_krw)+' 기록을 삭제합니다.'}</p>
    </FormModal>}
  </>;
}
