import React,{createContext,useContext,useEffect,useId,useRef,useState} from 'react';
import {QueryClient,QueryClientProvider,useQuery,useQueryClient} from '@tanstack/react-query';
import {api} from '../../api';
import {setFleetOwner,rememberFleetOwner,preferredFleetOwner,resolveFleetOwner} from '../../lib/fleetSession';
import {authScope,AUTH_CHANGED} from '../../authSession';
import {useCorporateInfo} from '../../state';
import {Modal,Input,Button,FormField} from '../ui';
import {BusinessError} from './BusinessWorkspace';
import Icon from '../Icon';
import {WorkspaceCompanyContext} from './WorkspaceHeader';
import './fleet-team.css';

export const fleetRoles={owner:'소유자',admin:'관리자',department_manager:'부서 관리자',member:'일반 사용자'};
const Context=createContext({role:'owner',manage_team:true,manage_vehicles:true,manage_reports:true,billing:true});
export const useFleetAccess=()=>useContext(Context);
export function useFleetOrganization(){return useQuery({queryKey:['fleet-organization'],queryFn:()=>api.fleetOrganization()});}
export function staffCanDrive(staff,vehicle){return staff.active&&(staff.all_vehicles!==false||staff.vehicle_ids?.includes(Number(vehicle?.id))||vehicle?.manager_staff_id===staff.id||vehicle?.asset?.manager_staff_id===staff.id);}

// A separate query cache per company prevents personal/other company data from
// being reused under identical legacy query keys. In-flight reads are guarded too.
export function FleetAccountScope({children,defaultOwner,allowedMemberships}) {
 const [preferred, setPreferred] = useState(preferredFleetOwner);
 const [revision, setRevision] = useState(0);
 const outer = useQueryClient();
 const owner = resolveFleetOwner(preferred, defaultOwner, allowedMemberships);
 const allowOwn = defaultOwner == null;
 function choose(value) {
   if (value == null && !allowOwn) return;
   rememberFleetOwner(value);
   setPreferred(value);
   setRevision(n => n + 1);
 }
 async function joined(id) {
   await outer.invalidateQueries({queryKey:['fleet-memberships']});
   choose(id);
 }
 return <ScopedCompany key={String(owner) + '-' + revision} owner={owner} allowOwn={allowOwn}
   onChoose={choose} onJoined={joined}>{children}</ScopedCompany>;
}
function ScopedCompany({owner,allowOwn,onChoose,onJoined,children}) {
 const [ready,setReady]=useState(false);
 const [client]=useState(()=>new QueryClient({defaultOptions:{queries:{retry:false,refetchOnWindowFocus:true}}}));
 useEffect(()=>{setFleetOwner(owner);setReady(true);return()=>{setFleetOwner(null);client.cancelQueries();client.clear();};},[owner,client]);
 useEffect(()=>{const previous=authScope();const clear=()=>{if(authScope()!==previous){setReady(false);client.cancelQueries();client.clear();setFleetOwner(null);}};window.addEventListener(AUTH_CHANGED,clear);return()=>window.removeEventListener(AUTH_CHANGED,clear);},[client]);
 return ready?<QueryClientProvider client={client}><AccessGate {...{owner,allowOwn,onChoose,onJoined}}>{children}</AccessGate></QueryClientProvider>:<p>회사 정보 확인 중…</p>;
}
function AccessGate({owner,allowOwn,onChoose,onJoined,children}) {
 const spaces=useQuery({queryKey:['fleet-workspaces'],queryFn:()=>api.fleetWorkspaces()});
 const access=useQuery({queryKey:['fleet-access'],queryFn:()=>api.fleetAccess(),refetchInterval:15000});
 const ownCompany=useCorporateInfo({enabled:allowOwn&&owner==null&&access.data?.role==='owner',staleTime:60000,retry:false});
 const [join,setJoin]=useState(false);
 const previous=useRef(null),signature=access.data?JSON.stringify(access.data):null;
 useEffect(()=>{if(signature&&previous.current&&previous.current!==signature){onChoose(owner);}previous.current=signature;},[signature]);
 const roleId=useId();
 const memberships=spaces.data?.memberships ?? [];
 const membership=memberships.find(m=>Number(m.owner_id)===owner);
 let companyName=ownCompany.data?.company_name?.trim()||'내 회사';
 if(membership) companyName=membership.company_name?.trim() || '회사명 미등록';
 else if(owner!=null) companyName=spaces.isPending ? '회사 확인 중…' : '선택한 회사';
 const roleName=fleetRoles[access.data?.role];
 const toolbar=(
   <div className="fleet-account-bar">
     <label className="fleet-company-picker" title={companyName}>
       <span className="fleet-company-mark"><Icon name="office" size={20}/></span>
       <span className="fleet-company-identity">
         <strong aria-hidden="true">{companyName}</strong>
         {roleName && <small id={roleId}>{roleName}</small>}
       </span>
       <Icon name="chevron-down" size={16}/>
       <select aria-label="회사 선택" aria-describedby={roleName ? roleId : undefined} value={owner??''} onChange={e=>onChoose(e.target.value ? Number(e.target.value) : null)}>
         {allowOwn && <option value="">내 회사</option>}
         {owner!=null && !membership && <option value={owner} disabled>{companyName}</option>}
         {memberships.map(m=><option value={m.owner_id} key={m.owner_id}>{m.company_name?.trim() || '회사명 미등록'} · {fleetRoles[m.role]}</option>)}
       </select>
     </label>
     <button type="button" className="fleet-company-invite" onClick={()=>setJoin(true)}>
       <Icon name="link" size={17}/>초대 코드로 연결
     </button>
     {join && <FleetJoin onClose={()=>setJoin(false)} onJoined={id=>{setJoin(false);onJoined(id);}}/>}
   </div>
 );
 if(access.error)return <div className="fleet-access-error">{toolbar}<BusinessError onRetry={access.refetch}>회사에 접근할 수 없습니다. 초대·활성 상태를 확인하거나 다른 회사를 선택해 주세요.</BusinessError></div>;
 if(!access.data)return <p>접근 권한 확인 중…</p>;
 const companyOptions=[...(allowOwn?[{value:'company',label:companyName&&owner==null?companyName:'내 회사'}]:[]),
   ...memberships.map(m=>({value:'fleet:'+m.owner_id,label:m.company_name?.trim()||'회사명 미등록'}))];
 if(owner!=null&&!membership)companyOptions.push({value:'fleet:'+owner,label:companyName});
 return <Context.Provider value={access.data}><WorkspaceCompanyContext.Provider value={{
   selected:owner==null?'company':'fleet:'+owner,options:companyOptions,onChange:value=>onChoose(value==='company'?null:Number(value.slice(5))),
 }}>{children(toolbar,companyName)}</WorkspaceCompanyContext.Provider></Context.Provider>;
}
export function FleetJoin({onClose,onJoined}) {
 const [code,setCode]=useState(''),[preview,setPreview]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
 async function submit(e){e.preventDefault();if(busy)return;setBusy(true);setError('');try{const r=await api.joinFleet({code:code.trim(),confirm:!!preview});if(preview)onJoined(r.owner_id);else setPreview(r);}catch{setPreview(null);setError('초대가 만료·취소되었거나 이미 연결된 계정입니다. 관리자에게 확인해 주세요.');}finally{setBusy(false);}}
 return <Modal open title="회사 초대 연결" onClose={busy?undefined:onClose}><form onSubmit={submit} className="fleet-team-form"><FormField label="초대 코드"><Input required value={code} autoComplete="off" maxLength={100} onChange={e=>{setCode(e.target.value);setPreview(null);}}/></FormField>{preview?<div className="fleet-invite-preview"><strong>{preview.company_name}</strong><p>{preview.staff_name} · {fleetRoles[preview.role]}</p><p>현재 로그인한 계정을 이 사용자와 연결합니다.</p></div>:<p className="business-note">관리자에게 받은 코드를 입력해 주세요. 코드는 7일 동안 한 번 사용할 수 있습니다.</p>}{error&&<p role="alert">{error}</p>}<div className="business-dialog-actions"><Button type="button" variant="ghost" onClick={onClose} disabled={busy}>취소</Button><Button type="submit" disabled={busy||!code.trim()}>{busy?'확인 중…':preview?'이 회사에 연결':'초대 확인'}</Button></div></form></Modal>;
}
