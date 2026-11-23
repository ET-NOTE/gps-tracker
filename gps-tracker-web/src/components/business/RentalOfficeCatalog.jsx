import React,{useState} from 'react';
import {useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {Button,Modal} from '../ui';
import Icon from '../Icon';
import RentalOfficeDelete from './RentalOfficeDelete';
import {BusinessRenters} from './BusinessPeople';
import {BusinessButton} from './BusinessWorkspace';
import {Field,FormModal,Metrics,Options,PeriodFields,Search,Table,Toolbar} from './RentalOfficeKit';
import {fillTemplate,initialPeriod,periodOk,templateKeys,won} from '../../lib/rentalOffice';
import {officeBookKey,officeCatalogKey} from './rentalOfficeKeys';
import RentalCustomerHistory from './RentalCustomerHistory';
import RentalRecordDrawer,{RecordFields,CustomerFields} from './RentalRecordDrawer';
import useCorporatePhone from '../../useCorporatePhone';
import {hideOutsideMockup} from '../../lib/mockupHidden';

const titles={customers:'고객',accounts:'법인 거래처',rates:'요금표',templates:'계약서 양식'};
const kinds={person:'개인',business:'법인 고객'}, billing={each:'건별',monthly:'월합산'};
const blank={
  customers:{kind:'person',phone:'',email:'',account_id:'',license_type:'',license_checked:false,memo:''},
  accounts:{contact:'',phone:'',business_number:'',billing:'each',memo:''},
  rates:{daily_krw:0,deposit_krw:0,coverage_krw:0},
  templates:{body:'{{회사명}} 대여 계약서\n\n계약번호 {{계약번호}}\n고객 {{고객명}}\n차량 {{차량번호}}\n대여 {{대여시작}} ~ {{반납예정}}\n대여요금 {{대여요금}}\n보증금 {{보증금}}'},
};
function Editor({kind,catalog,row,close}) {
  const qc=useQueryClient();
  const [form,setForm]=useState(()=>({...blank[kind],name:'',active:true,...row}));
  const update=(k,v)=>setForm(f=>({...f,[k]:v}));
  const txt=(key,label,props={})=><Field label={label}><input value={form[key]??''} onChange={e=>update(key,e.target.value)} maxLength={80} {...props}/></Field>;
  const note=(key,label,max,required)=><Field label={label} wide><textarea rows={kind==='templates'?8:3} maxLength={max} value={form[key]||''} required={required} onChange={e=>update(key,e.target.value)}/></Field>;
  const choice=(key,label,items)=><Field label={label}><select value={form[key]} onChange={e=>update(key,e.target.value)}><Options items={items}/></select></Field>;
  async function save() {
    const body={...form};
    if (kind==='customers') body.account_id=form.account_id?Number(form.account_id):null;
    if (kind==='rates') ['daily_krw','deposit_krw','coverage_krw'].forEach(k=>{body[k]=Number(form[k]);});
    await api.rentalOffice(row?'PATCH':'POST','/catalog/'+kind+(row?'/'+row.id:''),body);
    await qc.invalidateQueries({queryKey:officeCatalogKey()});
  }
  return <FormModal title={titles[kind]+(row?' 수정':' 등록')} onClose={close} save={save} size={kind==='rates'?530:720}>
    {txt('name',({customers:'고객명',accounts:'거래처명',rates:'차종 이름',templates:'양식 이름'})[kind],{required:true})}
    {kind==='customers' && <>
      {choice('kind','고객 구분',kinds)}
      {txt('phone','연락처',{type:'tel',required:true,maxLength:25})}{txt('email','이메일',{type:'email',maxLength:120})}
      <Field label="법인 거래처"><select value={form.account_id??''} onChange={e=>update('account_id',e.target.value)}><option value="">미연결</option>{catalog.accounts.filter(a=>a.active||a.id===Number(form.account_id)).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
      {txt('license_type','운전면허 종류',{maxLength:40,required:form.license_checked})}
      <label className="ro-check ro-wide"><input type="checkbox" checked={form.license_checked} onChange={e=>update('license_checked',e.target.checked)}/>운전면허 확인 완료</label>
      {note('memo','메모',1000,false)}
    </>}
    {kind==='accounts' && <>{txt('contact','담당자',{required:true,maxLength:40})}{txt('phone','연락처',{type:'tel',required:true,maxLength:25})}
      {txt('business_number','사업자등록번호',{maxLength:12})}{choice('billing','정산 방식',billing)}{note('memo','메모',1000,false)}</>}
    {kind==='rates' && <>{[['daily_krw','1일 대여요금 (원)'],['deposit_krw','보증금 (원)'],['coverage_krw','1일 자차 보장료 (원)']].map(([k,l])=><React.Fragment key={k}>{txt(k,l,{type:'number',min:0,max:1000000000,step:1,required:true})}</React.Fragment>)}</>}
    {kind==='templates' && <>{note('body','계약서 내용',20000,true)}<div className="ro-tokens ro-wide"><span>자동 입력 항목</span>{templateKeys.map(k=><code key={k}>{'{{'+k+'}}'}</code>)}</div></>}
    <label className="ro-check ro-wide"><input type="checkbox" checked={form.active} onChange={e=>update('active',e.target.checked)}/>사용 중</label>
  </FormModal>;
}
function Preview({row,devices,close}) {
  const [period,setPeriod]=useState(initialPeriod), [id,setId]=useState(null);
  const q=useQuery({queryKey:officeBookKey(period),queryFn:()=>api.rentalOffice('GET','/book?'+new URLSearchParams(period)),enabled:periodOk(period)});
  const selected=id??String(q.data?.contracts[0]?.id??'');
  const contract=q.data?.contracts.find(c=>String(c.id)===selected);
  return <Modal open mobileForm size={720} onClose={close} title="계약서 미리보기" subtitle={row.name}
    footer={<div className="service-form-actions"><Button onClick={close}>닫기</Button></div>}>
    <div className="ro-modal"><div className="ro-filters"><PeriodFields period={period} onChange={p=>{setId(null);setPeriod(p);}}/>
      <Field label="정보를 채울 계약"><select value={selected} onChange={e=>setId(e.target.value)}><option value="">양식 원문</option>{q.data?.contracts.map(c=><option key={c.id} value={c.id}>#{c.id} · {c.renter_name}</option>)}</select></Field></div>
      {!periodOk(period)&&<p role="alert">조회 기간을 1년 이내로 선택해 주세요.</p>}
      {q.isError&&<p role="alert">계약을 불러오지 못했습니다. <button onClick={()=>q.refetch()}>다시 시도</button></p>}
      <pre className="ro-paper">{fillTemplate(row.body,contract,q.data?.company_name,devices)}</pre>
    </div></Modal>;
}
export default function RentalOfficeCatalog({kind,catalog,devices}) {
  const mockup=!useCorporatePhone()&&hideOutsideMockup;
  const [query,setQuery]=useState(''),[status,setStatus]=useState('all'),[type,setType]=useState('all'),[account,setAccount]=useState('all'),[license,setLicense]=useState('all');
  const [extraOpen,setExtraOpen]=useState(false);
  const [edit,setEdit]=useState(undefined),[preview,setPreview]=useState(null),[history,setHistory]=useState(false);
  const [selectedId,setSelectedId]=useState(null),[relatedId,setRelatedId]=useState(null);
  const selected=catalog[kind].find(row=>row.id===selectedId);
  const related=catalog.customers.find(row=>row.id===relatedId);
  const findAccount=c=>catalog.accounts.find(a=>a.id===c.account_id)?.name;
  const rows=catalog[kind].filter(r=>(status==='all'||r.active===(status==='active')) &&
    (type==='all'||r.kind===type||r.billing===type) && (account==='all'||String(r.account_id??'')===account) &&
    (license==='all'||r.license_checked===(license==='yes')) &&
    [r.name,r.phone,r.email,r.contact,r.body,r.business_number,findAccount(r)].some(v=>String(v??'').toLowerCase().includes(query.trim().toLowerCase())));
  const editButton=r=><Button size="sm" variant="ghost" aria-label={r.name+' 수정'} onClick={()=>setEdit(r)}>수정</Button>;
  const openRecord=r=>setSelectedId(r.id);
  const recordLink=r=><button type="button" className="ro-detail-link" aria-label={r.name+' 상세 열기'} onClick={()=>openRecord(r)}>{r.name}</button>;
  const cols={
    customers:[['고객',c=><>{recordLink(c)}{c.email&&<small className="ro-secondary">{c.email}</small>}</>],['구분',c=>kinds[c.kind]],['연락처',c=>c.phone],['법인 거래처',findAccount],
      ['면허 확인',c=><span className={c.license_checked?'ro-status':'ro-status amber'}>{c.license_checked?'확인 완료':'확인 필요'}</span>],['대여 이력',c=>(c.contracts_count||0)+'건']],
    accounts:[['거래처',c=><>{recordLink(c)}{c.business_number&&<small className="ro-secondary">{c.business_number}</small>}</>],['담당자',c=>c.contact],['연락처',c=>c.phone],['정산 방식',c=>billing[c.billing]],
      ['연결 고객',c=>(c.customers_count||0)+'명'],['미수금',c=>won(c.outstanding_krw)]],
    rates:[['차종',recordLink],['1일 대여요금',c=>won(c.daily_krw)],['보증금',c=>won(c.deposit_krw)],['1일 자차 보장료',c=>won(c.coverage_krw)],['등록 차량',c=>(c.vehicles_count||0)+'대']],
    templates:[['양식 이름',recordLink],['내용',c=><span className="ro-excerpt">{c.body.slice(0,80)}</span>],['미리보기',c=><Button variant="ghost" size="sm" onClick={()=>setPreview(c)}>미리보기</Button>]]
  }[kind];
  const filter=(label,selected,onChange,items)=><Field label={label}><select value={selected} onChange={e=>onChange(e.target.value)}><Options items={items}/></select></Field>;
  const foldUsage=kind==='accounts'||kind==='customers';
  const directory=foldUsage||kind==='templates';
  const usage=filter('사용 여부',status,setStatus,{all:kind==='templates'?'전체 양식':'전체',active:'사용 중',inactive:'사용 중지'});
  const clearFilters=()=>{setQuery('');setStatus('all');setType('all');setAccount('all');setLicense('all');};
  const toolbar=<Toolbar count={rows.length} unit={kind==='accounts'?'개 거래처 조회':kind==='templates'?'개 양식 조회':kind==='customers'?'명 조회':'건'}>
    {directory ? <BusinessButton primary icon="plus" onClick={()=>setEdit(null)}>{kind==='templates'?'양식 추가':kind==='customers'?'고객 등록':'거래처 등록'}</BusinessButton> :
      <Button onClick={()=>setEdit(null)}>{titles[kind]} 등록</Button>}</Toolbar>;
  return <div className={'rental-office'+(directory?' rental-directory':'')}>
    {history&&<div className="ro-tabs"><button onClick={()=>setHistory(false)}>고객 명부</button><button aria-pressed="true" onClick={()=>setHistory(true)}>계약 이력·경고 관리</button></div>}
    {history?<BusinessRenters/>:<>
      {kind==='customers'&&<Metrics items={[['조회 고객',rows.length+'명'],['법인 고객',rows.filter(c=>c.kind==='business').length+'명'],['면허 확인 필요',rows.filter(c=>!c.license_checked).length+'명']]}/>}
      <div className="ro-filters">
        {kind==='customers'&&<>{filter('고객 구분',type,setType,{all:'전체',...kinds})}
          {filter('거래처',account,setAccount,{all:'전체','':'미연결',...Object.fromEntries(catalog.accounts.map(a=>[a.id,a.name]))})}
          {filter('면허 확인',license,setLicense,{all:'전체',yes:'확인 완료',no:'미확인'})}</>}
        {kind==='accounts'&&filter('정산 방식',type,setType,{all:'전체 방식',...billing})}
        {(!foldUsage||mockup)&&usage}
        <Search value={query} setValue={setQuery} label={kind==='accounts'?'거래처, 담당자, 등록번호 검색':kind==='templates'?'양식 이름, 내용 검색':titles[kind]+' 검색'}/>
        {directory ? <div className="rental-extra-actions">{foldUsage&&!mockup&&<BusinessButton aria-expanded={extraOpen} aria-controls="rental-directory-extra" onClick={()=>setExtraOpen(open=>!open)}>{kind==='customers'?'추가 조건·관리':'추가 조건'}{status==='all'?'':' (1)'}</BusinessButton>}<BusinessButton className="fleet-filter-reset-link" icon="refresh" onClick={clearFilters}>조건 초기화</BusinessButton></div> :
          (query||status!=='all'||type!=='all'||account!=='all'||license!=='all')&&<button type="button" className="fleet-filter-reset-link" onClick={clearFilters}><Icon name="refresh" size={13}/>조건 초기화</button>}
        {foldUsage&&<div className="rental-extra-filters" id="rental-directory-extra" hidden={!extraOpen}>{usage}
          {kind==='customers'&&<BusinessButton onClick={()=>setHistory(true)}>계약 이력·경고 관리</BusinessButton>}
        </div>}
      </div>
      {directory&&toolbar}
      <section className="ro-panel">{!directory&&toolbar}
        <Table columns={[...cols,['상태',r=><span className={r.active?'ro-status':'ro-status off'}>{r.active?'사용 중':'사용 중지'}</span>],['관리',editButton]]} rows={rows} empty={'조회된 '+titles[kind]+' 항목이 없습니다.'} onRecord={openRecord}/></section>
    </>}
    {selected&&kind==='rates'&&<RentalRecordDrawer title="요금표 상세" subtitle={selected.name} onClose={()=>setSelectedId(null)}
      footer={<Button variant="primary" onClick={()=>setEdit(selected)}>요금 수정</Button>}>
      <RecordFields rows={cols.slice(1).map(([label,render])=>[label,render(selected)])}/>
      <p className="rental-record-notice">변경한 요금은 새 견적에 적용됩니다. 기존 계약은 약정한 금액을 유지합니다.</p>
    </RentalRecordDrawer>}
    {selected&&kind==='templates'&&<RentalRecordDrawer title="계약서 양식" subtitle={selected.name} onClose={()=>setSelectedId(null)}
      footer={<><RentalOfficeDelete kind="templates" row={selected} onDeleted={()=>setSelectedId(null)}/>
        <Button variant="ghost" icon={<Icon name="eye" size={15}/>} onClick={()=>setPreview(selected)}>미리보기</Button>
        <Button variant="primary" icon={<Icon name="pencil" size={15}/>} onClick={()=>setEdit(selected)}>양식 수정</Button></>}>
      <div className="rental-template-status"><span className={selected.active?'ro-status':'ro-status off'}>{selected.active?'사용 중':'사용 중지'}</span><span>{selected.body.length.toLocaleString('ko-KR')}자</span></div>
      <pre className="ro-paper">{selected.body}</pre>
    </RentalRecordDrawer>}
    {selected&&(kind==='customers'||kind==='accounts')&&<RentalRecordDrawer title={titles[kind]+' 상세'} subtitle={selected.name} onClose={()=>setSelectedId(null)}
      footer={<>{mockup&&kind==='customers'&&<Button variant="ghost" onClick={()=>{setSelectedId(null);setHistory(true);}}>계약 이력·경고 관리</Button>}<Button variant="primary" onClick={()=>setEdit(selected)}>{kind==='accounts'?'거래처':'고객'} 수정</Button></>}>
      {kind==='customers'?<><CustomerFields person={selected} accounts={catalog.accounts}/><RentalCustomerHistory key={selected.id} customerId={selected.id}/></>:<>
        <RecordFields rows={[['사업자등록번호',selected.business_number],['담당자',selected.contact],['연락처',selected.phone],
          ['정산 방식',billing[selected.billing]],['현재 미수금',won(selected.outstanding_krw)]]}/>
        <section><h3>연결 고객 · {selected.customers_count||0}명</h3>{catalog.customers.filter(c=>String(c.account_id)===String(selected.id)).map(c=>
          <button type="button" key={c.id} className="rental-record-related" onClick={()=>setRelatedId(c.id)}>{c.name}<small>{c.phone}</small></button>)}</section>
        {selected.memo&&<section><h3>메모</h3><p className="rental-record-text">{selected.memo}</p></section>}
      </>}
    </RentalRecordDrawer>}
    {related&&<RentalRecordDrawer title="고객 상세" subtitle={related.name} onClose={()=>setRelatedId(null)}
      footer={<Button variant="primary" onClick={()=>setEdit(related)}>고객 수정</Button>}>
      <CustomerFields person={related} accounts={catalog.accounts}/><RentalCustomerHistory key={related.id} customerId={related.id}/>
    </RentalRecordDrawer>}
    {edit!==undefined&&<Editor row={edit} kind={related?'customers':kind} catalog={catalog} close={()=>setEdit(undefined)}/>}
    {preview&&<Preview row={preview} devices={devices} close={()=>setPreview(null)}/>}
  </div>;
}
