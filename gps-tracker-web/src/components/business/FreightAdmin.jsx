import { useState } from 'react';
import { useQuery,useQueryClient } from '@tanstack/react-query';
import FreightPolicySettings from './FreightPolicySettings';
import { api } from '../../api';
import { authScope } from '../../authSession';
import { newId, record } from '../../lib/freightWorkflow';
import { FreightTable,FreightFacts,FreightForm,FreightField,FreightButton,FreightFilters,FreightBadge } from './FreightKit';
import useCorporatePhone from '../../useCorporatePhone';
import { hideOutsideMockup } from '../../lib/mockupHidden';
import { TeamBranchDirectory, TeamCompanyCard, TeamServiceUsage } from './TeamMockupViews';

const codes=[['vehicleTypes','차량 형태'],['units','화물 수량 단위'],['chargeTypes','추가 비용 항목']];
const companyFields=[['name','회사명',80],['representative','대표자',80],['business_number','사업자등록번호',80],['phone','대표 전화',80],['address','주소',300]];

function usage(data,key,value) {
  const fields=key==='vehicleTypes'?[['vehicles','type'],['orders','vehicleType'],['recurring','vehicleType'],['rates','vehicleType']]:key==='units'?[['orders','unit'],['recurring','unit']]:[['charges','kind']];
  return fields.reduce((n,[table,k])=>n+data[table].filter(r=>r[k]===value).length,0);
}

function Company({data={}}) {
  const key=['cargo-team',authScope()],qc=useQueryClient(),q=useQuery({queryKey:key,queryFn:()=>api.cargoTeam('GET','/config')});
  const [editor,setEditor]=useState(null);
  const mockup=!useCorporatePhone()&&hideOutsideMockup;
  if(q.isPending)return <p role="status">회사 정보를 불러오는 중…</p>;
  if(q.error)return <FreightButton onClick={()=>q.refetch()}>회사 정보 다시 불러오기</FreightButton>;
  const company=q.data.company;
  async function submit(form) {
    try {await api.cargoTeam('PUT','/company',{...Object.fromEntries(form),revision:editor.revision});}
    catch(e){if(e.status===409){setEditor(null);await qc.invalidateQueries({queryKey:key});}throw e;}
    setEditor(null);await qc.invalidateQueries({queryKey:key});
  }
  const form=editor&&<FreightForm title="회사 정보 수정" onClose={()=>setEditor(null)} onSubmit={submit}>
      {companyFields.map(([k,label,max])=><FreightField key={k} label={label} wide={k==='address'}><input name={k} maxLength={max} required={k==='name'} defaultValue={editor[k]||''}/></FreightField>)}
    </FreightForm>;
  if(mockup){
    // Desktop design: company card and service usage side by side, from the team config and the cargo records.
    const team=q.data, vehicles=data.vehicles||[], staff=team.staff||[], branches=team.branches||[];
    const facts=[['사업자등록번호',company.business_number],['대표자',company.representative],['연락처',company.phone],['주소',company.address],['운영 지점',branches.length?branches.map(b=>b.name).join(', '):'']];
    const linked=vehicles.filter(v=>v.deviceId).length, joined=staff.filter(s=>s.active&&s.joined).length;
    return <div className="rt-mockup rt-company-service"><TeamCompanyCard name={company.name} caption="화물 운송 업무 공간" facts={facts} onEdit={()=>setEditor(company)}/>
      <TeamServiceUsage bars={[['등록 차량',linked,vehicles.length,'대','단말 연결'],['등록 사용자',joined,staff.length,'명','사용 중']]}
        facts={[['연결 단말',linked+'대'],['권한 그룹',(team.groups||[]).length+'개']]}/>{form}</div>;
  }
  return <section className="fr-card"><div className="fr-toolbar"><h2>사업장 정보</h2><FreightButton onClick={()=>setEditor(company)}>회사 정보 수정</FreightButton></div>
    <FreightFacts items={companyFields.map(([k,label])=>[label,company[k]||'미등록'])}/>
    {editor&&<FreightForm title="회사 정보 수정" onClose={()=>setEditor(null)} onSubmit={submit}>
      {companyFields.map(([k,label,max])=><FreightField key={k} label={label} wide={k==='address'}><input name={k} maxLength={max} required={k==='name'} defaultValue={editor[k]||''}/></FreightField>)}
    </FreightForm>}</section>;
}

export default function FreightAdmin({page,data,save,onPage}){
  const mockup=!useCorporatePhone()&&hideOutsideMockup;
  const [editor,setEditor]=useState(null),[tab,setTab]=useState('vehicleTypes'),[query,search]=useState('');
  if(page==='company')return <Company data={data}/>;
  if(page==='cargo-policies'||page==='cargo-integrations')return <FreightPolicySettings policy={page==='cargo-policies'} data={data} save={save} onPage={onPage}/>;
  const branch=page==='organization',title=branch?'지점':'기준정보';
  const props={title:branch?(editor?.id?'지점 수정':'지점 등록'):((editor?.label||'')+' '+(editor?.remove?'삭제':editor?.original?'수정':'추가')),submitLabel:editor?.remove?'삭제':'저장',onClose:()=>setEditor(null),
    onSubmit:async form=>{
      const next=structuredClone(data);
      if(branch){
        const name=String(form.get('name')).trim();
        if(!name || data.branches.some(b=>b.id!==editor.id && b.name===name))throw Error('중복되지 않는 지점명을 입력해 주세요.');
        if(editor.id)next.branches.find(b=>b.id===editor.id).name=name;
        else next.branches.push({id:newId(),name,active:true});
      }else{
        const {key,original,remove}=editor, list=next.codes[key];
        if(original && usage(next,key,original)) throw Error('다른 기록에서 사용 중인 항목입니다.');
        if(remove){if(list.length<=1)throw Error('항목을 하나 이상 유지해 주세요.');next.codes[key]=list.filter(k=>k!==original);}
        else {const value=String(form.get('value')).trim();
          if(!value||list.some(k=>k!==original&&k.toLowerCase()===value.toLowerCase()))throw Error('중복되지 않는 항목명을 입력해 주세요.');
          if(original)list[list.indexOf(original)]=value;else list.push(value);}
      }
      record(next,null,title+' 변경');await save(next);setEditor(null);
    }};
  return <div className={'fr-page'+(branch?'':' fr-codes')}>
    {branch&&mockup?<div className="rt-mockup"><TeamBranchDirectory onAdd={()=>setEditor({})} onEdit={b=>setEditor(data.branches.find(x=>x.id===b.id))} branches={data.branches.map(b=>{const people=(data.drivers||[]).filter(d=>d.branchId===b.id).length,vehicles=data.vehicles.filter(v=>v.branchId===b.id).length,orders=data.orders.filter(v=>v.branchId===b.id).length;return {id:b.id,name:b.name,members:people+'명',usage:<span className={'rt-badge '+(vehicles||orders?'good':'')}>{vehicles||orders?'차량 '+vehicles+'대 · 주문 '+orders+'건':'사용 기록 없음'}</span>};})}/></div>
    :branch?<><div className="fr-toolbar"><strong>운영 지점 {data.branches.length}개</strong><FreightButton primary icon="plus" onClick={()=>setEditor({})}>지점 등록</FreightButton></div>
      <FreightTable columns={['지점명','등록 차량','운송 주문','관리']} rows={data.branches.map(b=>({id:b.id,cells:[b.name,data.vehicles.filter(v=>v.branchId===b.id).length+'대',data.orders.filter(v=>v.branchId===b.id).length+'건',<FreightButton onClick={()=>setEditor(b)}>수정</FreightButton>]}))} empty="등록된 지점이 없습니다."/></>:
      <><div className="fr-toolbar"><div className="fr-tabs">{codes.map(([k,label])=><button type="button" className="fr-tab" key={k} aria-pressed={k===tab} onClick={()=>{setTab(k);search('');}}>{label}</button>)}</div><FreightButton primary icon="plus" onClick={()=>setEditor({key:tab,label:codes.find(([k])=>k===tab)[1]})}>항목 추가</FreightButton></div>
      <FreightFilters resetLabel={mockup?'초기화':undefined} query={query} onQuery={search} placeholder="기준정보 이름" onReset={()=>search('')}/>{/* Desktop design has no 관리 column: an editable row opens the edit dialog, which also offers 삭제. */}
      <FreightTable columns={[codes.find(([k])=>k===tab)[1],'사용 중인 기록','관리 상태',...(mockup?[]:['관리'])]} rows={data.codes[tab].filter(v=>v.includes(query)).map(v=>{const n=usage(data,tab,v),row={key:tab,original:v,label:codes.find(([k])=>k===tab)[1]};
        const open=!n?()=>setEditor({...row,canRemove:data.codes[tab].length>1}):undefined;
        if(mockup)return {id:v,onOpen:open,cells:[open?<button type="button" className="fr-record-link" aria-label={v+' 수정'} onClick={open}>{v}</button>:v,n+'건',<FreightBadge tone={n?'blue':'neutral'}>{n?'사용 중':'편집 가능'}</FreightBadge>]};
        return {id:v,cells:[v,n+'건',<FreightBadge tone={n?'blue':'neutral'}>{n?'사용 중':'편집 가능'}</FreightBadge>,<div className="fr-actions"><FreightButton disabled={!!n} onClick={()=>setEditor(row)}>수정</FreightButton><FreightButton disabled={!!n||data.codes[tab].length<=1} onClick={()=>setEditor({...row,remove:true})}>삭제</FreightButton></div>]};})}/></>}
    {editor&&<FreightForm {...props}>
      {branch?<FreightField label="지점명" wide><input required name="name" maxLength={80} defaultValue={editor.name}/></FreightField>:
        editor.remove?<p className="fr-note">‘{editor.original}’ 항목을 삭제할까요?</p>:<><FreightField label={editor.label} wide><input required name="value" defaultValue={editor.original} maxLength={40}/></FreightField>
          {mockup&&editor.canRemove&&<div className="fr-actions"><FreightButton onClick={()=>setEditor({...editor,remove:true})}>삭제</FreightButton></div>}</>}
    </FreightForm>}
  </div>;
}
