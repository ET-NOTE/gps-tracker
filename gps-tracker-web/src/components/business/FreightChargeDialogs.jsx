import {FreightButton,FreightDrawer,FreightFacts,FreightForm} from './FreightKit';
import {choices,choicesFrom,FormField,formValues} from './FreightOfficeFields';
import {chargeStates,reviewCharge,saveCharge} from '../../lib/freightFinance';
import {costLabel,getRow,stamp,timeLabel} from '../../lib/freightWorkflow';

export const amounts=[['sellAmount','화주 추가 청구액'],['buyAmount','운송사 추가 지급액'],['companyCost','회사 부담액']];
export const tones={pending:'amber',approved:'green',rejected:'red'};
export default function FreightChargeDialogs({data,save,view,setView,shipmentId}) {
  const row=view?.id&&getRow(data,'charges',view.id);
  const fields=[{key:'shipmentId',label:'운송 건',options:choicesFrom(data.shipments,'number'),required:true,wide:true},
    {key:'kind',label:'비용 항목',options:choices(data.codes.chargeTypes),required:true},{key:'at',label:'발생 일시',type:'datetime-local',defaultValue:stamp(),required:true},
    ...amounts.map(([key,label])=>({key,label:label+' (원)',type:'number',defaultValue:0,min:0,max:1e9,required:true})),
    {key:'note',label:'발생 사유',type:'textarea',maxLength:500,required:true}];
  const close=()=>setView(null), detail=()=>row?setView({action:'detail',id:row.id}):close();
  async function submit(form) {
    const next=structuredClone(data), old=row?getRow(next,'charges',row.id):null;
    if(view.action==='form')saveCharge(next,old,formValues(form,fields));
    else reviewCharge(next,old,view.action,String(form.get('note')||''));
    await save(next);setView({action:'detail',id:old?.id||next.charges[0].id});
  }
  return <>
    {row&&view.action==='detail'&&<FreightDrawer title="추가 비용 상세" subtitle={(getRow(data,'shipments',row.shipmentId)?.number||'—')+' · '+row.kind} onClose={close} footer={<div className="fr-actions">
      <FreightButton onClick={close}>닫기</FreightButton>{row.status!=='approved'&&<FreightButton onClick={()=>setView({action:'form',id:row.id})}>정보 수정</FreightButton>}
      {row.status==='pending'&&<><FreightButton onClick={()=>setView({action:'rejected',id:row.id})}>반려</FreightButton><FreightButton primary onClick={()=>setView({action:'approved',id:row.id})}>승인</FreightButton></>}</div>}>
      <FreightFacts items={[['상태',chargeStates[row.status]],['발생 일시',timeLabel(row.at)],...amounts.map(([k,l])=>[l,costLabel(row[k])]),['발생 사유',row.note],
        ...(row.reviewedAt?[['검토 일시',timeLabel(row.reviewedAt)],['검토 메모',row.reviewNote||'—']]:[])]}/>
    </FreightDrawer>}
    {view?.action==='form'&&<FreightForm size={720} title={'추가 비용 '+(row?'수정':'등록')} onClose={detail} onSubmit={submit}>{fields.map(f=><FormField key={f.key} field={f} initial={row||{shipmentId}}/>)}</FreightForm>}
    {row&&['approved','rejected'].includes(view?.action)&&<FreightForm size={530} title={'추가 비용 '+chargeStates[view.action]} subtitle={row.kind} onClose={detail} onSubmit={submit} submitLabel={chargeStates[view.action]}>
      <p className="fr-note">{amounts.map(([k,l])=>l+' '+costLabel(row[k])).join(' · ')}</p><FormField field={{key:'note',label:view.action==='rejected'?'반려 사유':'검토 메모',type:'textarea',maxLength:500,required:view.action==='rejected'}}/>
    </FreightForm>}
  </>;
}
