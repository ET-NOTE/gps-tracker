import { useState } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { newId, record } from '../../lib/freightWorkflow';
import { FreightTable,FreightFacts,FreightForm,FreightField,FreightButton,FreightFilters } from './FreightKit';

const numbers=[['bufferMinutes','운송 사이 준비 시간',0,1440],['acceptTimeoutMinutes','수락 대기 기준',1,1440],['offlineMinutes','단말 수신 지연 기준',1,240]];
const rules=[['ownAutoConfirm','자사 차량 배차 시 바로 확정'],['requireDriverCheck','배차 전에 기사 면허 확인'],['requireProofForBilling','청구 전에 인수증 확인']];
const notices=[['dispatchNotice','배차 수락 대기'],['delayNotice','운송 지연·사고'],['proofNotice','인수증 확인'],['connectionNotice','단말 수신 지연']];
const codes=[['vehicleTypes','차량 형태'],['units','화물 단위'],['chargeTypes','추가 비용 항목']];
const companyFields=[['name','회사명',80],['representative','대표자',80],['business_number','사업자등록번호',80],['phone','대표 전화',80],['address','주소',300]];

function usage(data,key,value) {
  const fields=key==='vehicleTypes'?[['vehicles','type'],['orders','vehicleType'],['recurring','vehicleType'],['rates','vehicleType']]:key==='units'?[['orders','unit'],['recurring','unit']]:[['charges','kind']];
  return fields.reduce((n,[table,k])=>n+data[table].filter(r=>r[k]===value).length,0);
}

function Company() {
  const key=['cargo-team',authScope()],qc=useQueryClient(),q=useQuery({queryKey:key,queryFn:()=>api.cargoTeam('GET','/config')});
  const [editor,setEditor]=useState(null);
  if(q.isPending)return <p role="status">회사 정보를 불러오는 중…</p>;
  if(q.error)return <FreightButton onClick={()=>q.refetch()}>회사 정보 다시 불러오기</FreightButton>;
  const company=q.data.company;
  async function submit(form) {
    try {await api.cargoTeam('PUT','/company',{...Object.fromEntries(form),revision:editor.revision});}
    catch(e){if(e.status===409){setEditor(null);await qc.invalidateQueries({queryKey:key});}throw e;}
    setEditor(null);await qc.invalidateQueries({queryKey:key});
  }
  return <section className="fr-card"><div className="fr-toolbar"><h2>사업장 정보</h2><FreightButton onClick={()=>setEditor(company)}>회사 정보 수정</FreightButton></div>
    <FreightFacts items={companyFields.map(([k,label])=>[label,company[k]||'미등록'])}/>
    {editor&&<FreightForm title="회사 정보 수정" onClose={()=>setEditor(null)} onSubmit={submit}>
      {companyFields.map(([k,label,max])=><FreightField key={k} label={label} wide={k==='address'}><input name={k} maxLength={max} required={k==='name'} defaultValue={editor[k]||''}/></FreightField>)}
    </FreightForm>}</section>;
}

export default function FreightAdmin({page,data,save,onPage}){
  const [editor,setEditor]=useState(null),[tab,setTab]=useState('vehicleTypes'),[query,search]=useState('');
  if(page==='company')return <Company/>;
  const branch=page==='organization',policy=page==='cargo-policies',code=page==='cargo-codes';
  const area=branch?'branches':policy?'policies':code?'codes':'integrations';
  const title=branch?'지점':policy?'배차·운송 정책':code?'기준정보':'알림 설정';
  const props={title:branch?(editor?.id?'지점 수정':'지점 등록'):code?((editor?.label||'')+' '+(editor?.remove?'삭제':editor?.original?'수정':'추가')):title+' 수정',submitLabel:editor?.remove?'삭제':'저장',onClose:()=>setEditor(null),
    onSubmit:async form=>{
      const next=structuredClone(data);
      if(branch){
        const name=String(form.get('name')).trim();
        if(!name || data.branches.some(b=>b.id!==editor.id && b.name===name))throw Error('중복되지 않는 지점명을 입력해 주세요.');
        if(editor.id)next.branches.find(b=>b.id===editor.id).name=name;
        else next.branches.push({id:newId(),name,active:true});
      }else if(code){
        const {key,original,remove}=editor, list=next.codes[key];
        if(original && usage(next,key,original)) throw Error('다른 기록에서 사용 중인 항목입니다.');
        if(remove){if(list.length<=1)throw Error('항목을 하나 이상 유지해 주세요.');next.codes[key]=list.filter(k=>k!==original);}
        else {const value=String(form.get('value')).trim();
          if(!value||list.some(k=>k!==original&&k.toLowerCase()===value.toLowerCase()))throw Error('중복되지 않는 항목명을 입력해 주세요.');
          if(original)list[list.indexOf(original)]=value;else list.push(value);}
      }else{
        if(policy)for(const [k] of numbers)next.policies[k]=Number(form.get(k));
        for(const [k] of (policy?rules:notices))next[area][k]=form.has(k);
      }
      record(next,null,title+' 변경');await save(next);setEditor(null);
    }};
  return <div className="fr-page">
    {branch?<><div className="fr-toolbar"><strong>운영 지점 {data.branches.length}개</strong><FreightButton primary icon="plus" onClick={()=>setEditor({})}>지점 등록</FreightButton></div>
      <FreightTable columns={['지점명','등록 차량','운송 주문','관리']} rows={data.branches.map(b=>({id:b.id,cells:[b.name,data.vehicles.filter(v=>v.branchId===b.id).length+'대',data.orders.filter(v=>v.branchId===b.id).length+'건',<FreightButton onClick={()=>setEditor(b)}>수정</FreightButton>]}))} empty="등록된 지점이 없습니다."/></>:
      code?<><div className="fr-toolbar"><div className="fr-tabs">{codes.map(([k,label])=><button type="button" className="fr-tab" key={k} aria-pressed={k===tab} onClick={()=>{setTab(k);search('');}}>{label}</button>)}</div><FreightButton primary onClick={()=>setEditor({key:tab,label:codes.find(([k])=>k===tab)[1]})}>항목 추가</FreightButton></div>
      <FreightFilters query={query} onQuery={search} placeholder="기준정보 이름"/><FreightTable columns={['이름','사용 중인 기록','관리']} rows={data.codes[tab].filter(v=>v.includes(query)).map(v=>{const n=usage(data,tab,v),row={key:tab,original:v,label:codes.find(([k])=>k===tab)[1]};return {id:v,cells:[v,n+'건',<div className="fr-actions"><FreightButton disabled={!!n} onClick={()=>setEditor(row)}>수정</FreightButton><FreightButton disabled={!!n||data.codes[tab].length<=1} onClick={()=>setEditor({...row,remove:true})}>삭제</FreightButton></div>]};})}/></>:
      <section className="fr-card"><div className="fr-toolbar"><h2>{policy?'배차 기준과 완료 조건':'운영현황에 표시할 알림'}</h2><FreightButton onClick={()=>setEditor({})}>설정 수정</FreightButton></div>
        <FreightFacts items={[...(policy?numbers.map(([k,label])=>[label,data.policies[k]+'분']):[]),...(policy?rules:notices).map(([k,label])=>[label,data[area][k]?'사용':'사용 안 함'])]}/>
        {!policy&&<FreightButton onClick={()=>onPage('cargo-dashboard')}>운영현황에서 알림 보기</FreightButton>}</section>}
    {editor&&<FreightForm {...props}>
      {branch?<FreightField label="지점명" wide><input required name="name" maxLength={80} defaultValue={editor.name}/></FreightField>:
        code&&editor.remove?<p className="fr-note">‘{editor.original}’ 항목을 삭제할까요?</p>:code?<FreightField label={editor.label} wide><input required name="value" defaultValue={editor.original} maxLength={40}/></FreightField>:<>
          {policy&&numbers.map(([k,label,min,max])=><FreightField key={k} label={label+' (분)'}><input required name={k} type="number" min={min} max={max} defaultValue={data.policies[k]}/></FreightField>)}
          <fieldset className="fr-checks"><legend>{policy?'적용할 조건':'표시할 알림'}</legend>{(policy?rules:notices).map(([k,label])=><label key={k}><input type="checkbox" name={k} defaultChecked={data[area][k]}/>{label}</label>)}</fieldset>
        </>}
    </FreightForm>}
  </div>;
}
