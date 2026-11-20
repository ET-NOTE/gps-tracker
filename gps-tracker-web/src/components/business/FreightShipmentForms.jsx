import {useEffect,useRef,useState} from 'react';
import {api} from '../../api';
import {FreightButton,FreightFacts,FreightField,FreightForm,FreightOptions} from './FreightKit';
import {assign,assignProblem,candidate,epoch,firstOrder,getRow,inputTime,moneyValue,nameOf,record,routeName,shipAction,stamp,stepMap,timeLabel,vehicleName} from '../../lib/freightWorkflow';

export function FreightAssignForm({data,order,shipment,initialVehicle,commit,onClose}){
  const [vid,setVid]=useState(initialVehicle||shipment?.vehicleId||''),[did,setDid]=useState(()=>shipment?.driverId||
    (initialVehicle?candidate(data,order,getRow(data,'vehicles',initialVehicle)).driver?.id:'')||'');
  const vehicle=getRow(data,'vehicles',vid);
  const drivers=vehicle?data.drivers.filter(d=>(vehicle.carrierId||'')===(d.carrierId||'')):[];
  function choose(id){
    setVid(id);const v=getRow(data,'vehicles',id);
    setDid(v?candidate(data,order,v,shipment?.id).driver?.id||'':'');
  }
  const reason=vehicle?assignProblem(data,order,vehicle,getRow(data,'drivers',did),shipment?.id):'';
  return <FreightForm title={shipment?'차량·기사 재배차':'차량·기사 배차'} subtitle={order.number+' · '+routeName(data,order)} submitLabel={shipment?'재배차':'배차 등록'} onClose={onClose} onSubmit={async form=>{
    const note=String(form.get('note')||'').trim();
    if(shipment&&!note)throw Error('재배차 사유를 입력해 주세요.');
    await commit(next=>assign(next,getRow(next,'orders',order.id),{vehicleId:vid,driverId:did,sellAmount:moneyValue(form.get('sell')),buyAmount:moneyValue(form.get('buy')),note},shipment&&getRow(next,'shipments',shipment.id)));
  }}>
    <FreightField label="배차 차량"><select required value={vid} onChange={e=>choose(e.target.value)}><option value="">차량 선택</option>{data.vehicles.map(v=><option key={v.id} value={v.id}>{v.plate} · {v.type} · {v.capacityKg.toLocaleString()}kg</option>)}</select></FreightField>
    <FreightField label="운행 기사"><select required value={did} onChange={e=>setDid(e.target.value)}><FreightOptions rows={drivers} blank="기사 선택"/></select></FreightField>
    {reason&&<p className="fr-note" role="status">{reason}</p>}
    <FreightField label="화주 합의 운임 (원)"><input type="number" name="sell" min="0" max="1000000000" placeholder="미정" defaultValue={(shipment||order).sellAmount??''}/></FreightField>
    <FreightField label="운송 합의 원가 (원)"><input type="number" name="buy" min="0" max="1000000000" placeholder="미정" defaultValue={(shipment||order).buyAmount??''}/></FreightField>
    <FreightField wide label={shipment?'재배차 사유':'배차 메모'}><textarea name="note" required={!!shipment} maxLength={500}/></FreightField>
    {vehicle&&!reason&&<p className="fr-note">{!vehicle.carrierId&&data.policies.ownAutoConfirm?'직영 차량의 배차가 즉시 확정됩니다.':'등록 후 기사·운송사의 수락을 확인해 주세요.'}</p>}
  </FreightForm>;
}
const titles={accept:'배차 수락·확정',decline:'배차 거절',release:'배차 해제',arrived:'상차지 도착',loaded:'상차 완료',delivered:'하차 완료',approved:'인수증 확인 완료',rework:'인수증 보완 요청'};
export function FreightActionForm({action,data,shipment:s,commit,onClose}){
  const reason=['release','decline','rework'].includes(action),milestone=Object.values(stepMap).some(step=>step.type===action);
  const lastAt=Math.max(Date.now(),...(s.events||[]).map(e=>epoch(e.at)).filter(Number.isFinite));
  return <FreightForm size="md" title={titles[action]} subtitle={s.number+' · '+vehicleName(data,s.vehicleId)} onClose={onClose} submitLabel={titles[action]} onSubmit={async form=>{
    const note=String(form.get('note')||'').trim();
    if(reason&&!note)throw Error('사유를 입력해 주세요.');
    if(!reason&&!form.has('confirmed'))throw Error('확인 항목을 선택해 주세요.');
    await commit(next=>{
      const row=getRow(next,'shipments',s.id);
      if(action==='approved'||action==='rework'){
        if(row?.status!=='delivered'||row.proof.status!=='submitted')throw Error('확인 대기 중인 인수증을 선택해 주세요.');
        Object.assign(row.proof,{status:action,reviewedAt:stamp(),reviewNote:note});
        record(next,row,titles[action]+(note?' · '+note:''));
      }else shipAction(next,row,action,{note,at:form.get('at')||stamp()});
    });
  }}>
    <div className="fr-note"><FreightFacts items={[['운행 기사',nameOf(data,'drivers',s.driverId)],['운송 구간',routeName(data,firstOrder(data,s))],['작업 시간',timeLabel(s.start)+' ~ '+timeLabel(s.end)]]}/></div>
    {milestone&&<FreightField wide label="처리 일시"><input name="at" type="datetime-local" required defaultValue={stamp(lastAt)}/></FreightField>}
    <FreightField label={reason?'처리 사유':'확인 메모'} wide><textarea name="note" required={reason} maxLength={500}/></FreightField>
    {!reason&&<label className="fr-checks"><input type="checkbox" required name="confirmed"/>{action==='accept'?'기사·운송사의 수락을 확인했습니다.':action==='approved'?'제출된 인수증을 확인했습니다.':'현장 처리 내용을 확인했습니다.'}</label>}
  </FreightForm>;
}
function readPhoto(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onload=()=>resolve(reader.result);
    reader.onerror=()=>reject(Error('사진을 읽을 수 없습니다.'));
    reader.readAsDataURL(file);
  });
}
function ProofImage({file}){
  const [url,setUrl]=useState(''),[error,setError]=useState('');
  useEffect(()=>{
    let live=true,objectUrl;
    api.getCargoProofImage(file.id).then(blob=>{
      if(live){objectUrl=URL.createObjectURL(blob);setUrl(objectUrl);}
    }).catch(e=>{if(live)setError(e.message);});
    return ()=>{live=false;if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[file.id]);
  return url?<a href={url} target="_blank" rel="noreferrer"><img src={url} alt={file.name||'인수증 사진'}/></a>:<span role="status">{error||'사진 불러오는 중…'}</span>;
}
export function FreightPhotos({files=[]}){
  return files.length>0&&<div className="fr-photos">{files.map(f=><ProofImage key={f.id} file={f}/>)}</div>;
}
export function FreightProofForm({shipment:s,commit,onClose}){
  const prior=s.proof, deliveredAt=(s.events||[]).findLast(e=>e.type==='delivered')?.at||s.end;
  const [existing,setExisting]=useState(prior.files||[]),[pending,setPending]=useState([]),[fileError,setFileError]=useState('');
  const uploaded=useRef(new Map());
  function pick(e){
    const added=[...e.target.files];e.target.value='';
    if(existing.length+pending.length+added.length>3){setFileError('사진은 최대 3장까지 첨부할 수 있습니다.');return;}
    if(added.some(f=>!['image/jpeg','image/png','image/webp'].includes(f.type)||f.size>500*1024||!f.size)){setFileError('500KB 이하 JPEG·PNG·WebP 사진을 선택해 주세요.');return;}
    setPending([...pending,...added]);setFileError('');
  }
  return <FreightForm title="인수증·수령 확인 제출" subtitle={s.number} onClose={onClose} submitLabel="제출" onSubmit={async form=>{
    const receiver=String(form.get('receiver')||'').trim(),note=String(form.get('note')||'').trim(),at=form.get('at');
    if(epoch(at)<epoch(deliveredAt))throw Error('수령 확인 일시는 하차 완료 이후로 입력해 주세요.');
    if(!existing.length&&!pending.length&&(!receiver||!note))throw Error('사진을 첨부하거나 수령인과 확인 메모를 입력해 주세요.');
    const files=[...existing];
    for(const file of pending){
      if(!uploaded.current.has(file)){
        const {id}=await api.uploadCargoProof(await readPhoto(file));uploaded.current.set(file,{id,name:file.name.slice(0,180)});
      }
      const photo=uploaded.current.get(file);
      if(files.some(item=>item.id===photo.id))throw Error('같은 사진이 중복되었습니다. 첨부를 확인해 주세요.');
      files.push(photo);
    }
    await commit(next=>{
      const row=getRow(next,'shipments',s.id);
      if(row?.status!=='delivered'||row.proof.status==='approved')throw Error('인수증 상태를 다시 확인해 주세요.');
      row.proof={status:'submitted',receiver,at,note,files,reviewedAt:'',reviewNote:''};record(next,row,'인수증·수령 확인 제출');
    });
  }}>
    <FreightField label="수령 확인 일시"><input name="at" type="datetime-local" min={inputTime(deliveredAt)} required defaultValue={inputTime(prior.at)||stamp(Math.max(Date.now(),epoch(deliveredAt)))}/></FreightField>
    <FreightField label="수령인"><input name="receiver" maxLength={80} defaultValue={prior.receiver}/></FreightField>
    <FreightField wide label="인수증 사진 (최대 3장, 장당 500KB)"><input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={pick}/></FreightField>
    {fileError&&<p className="fr-note fr-error" role="alert">{fileError}</p>}
    <div className="fr-note">{existing.map(f=><div className="fr-actions" key={f.id}><span>{f.name}</span><FreightButton onClick={()=>setExisting(existing.filter(v=>v.id!==f.id))}>첨부 해제</FreightButton></div>)}
      {pending.map((f,i)=><div className="fr-actions" key={i}><span>{f.name}</span><FreightButton onClick={()=>setPending(pending.filter((v,k)=>k!==i))}>첨부 해제</FreightButton></div>)}</div>
    <FreightField label="수령 확인 메모" wide><textarea name="note" maxLength={1500} defaultValue={prior.note}/></FreightField>
    <label className="fr-checks"><input type="checkbox" required/>사진 또는 수령인 확인 내용을 확인했습니다.</label>
  </FreightForm>;
}
