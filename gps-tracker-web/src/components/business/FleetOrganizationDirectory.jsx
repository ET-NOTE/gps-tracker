import React,{useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../../api';
import Icon from '../Icon';
import BusinessDrawer from './BusinessDrawer';
import {inDepartment} from '../../lib/fleetPeopleReport';
import './fleet-organization-directory.css';

const kinds=[['department','부서'],['position','직책']];

export default function FleetOrganizationDirectory({items,roster,ready,onEdit,onSites,sites,initialKind='department'}) {
  const [kind,setKind]=useState(sites||initialKind!=='site'?initialKind:'department'),[selectedId,setSelectedId]=useState(null);
  // Branches share this page as a third tab when the caller provides the branch view.
  const siteList=useQuery({queryKey:['fleet-sites'],queryFn:()=>api.listFleetSites(),enabled:!!sites});
  const label=kind==='department'?'부서':'직책';
  const visible=items.filter(item=>item.kind===kind);
  const selected=visible.find(item=>item.id===selectedId);
  const members=item=>roster.filter(person=>kind==='department'?inDepartment(person,item.id):person.position_id!=null?String(person.position_id)===String(item.id):person.position===item.name);
  const count=item=>ready?members(item).length+'명':'—';
  const status=item=><span className={'business-badge '+(item.active?'good':'')}>{item.active?'사용 중':'사용 중지'}</span>;
  return <div className="fleet-org-directory">
    <div className="fleet-org-toolbar"><div className="fleet-org-tabs" aria-label="조직 관리 구분">
      {kinds.map(([value,name])=><button type="button" key={value} aria-pressed={kind===value} onClick={()=>{setSelectedId(null);setKind(value);}}>{name}<small>{items.filter(item=>item.kind===value).length}</small></button>)}
      {sites?<button type="button" aria-pressed={kind==='site'} onClick={()=>{setSelectedId(null);setKind('site');}}>지점<small>{siteList.data?siteList.data.length:''}</small></button>:onSites&&<button type="button" onClick={onSites}>지점</button>}
    </div>{onEdit&&kind!=='site'&&<button type="button" className="business-button is-primary" onClick={()=>onEdit({kind,name:'',active:true})}><Icon name="plus" size={15}/>{label} 추가</button>}</div>
    {kind==='site'?<div className="fleet-org-sites">{sites}</div>:<section className="fleet-org-section" aria-label={label+' 관리'}><header><h3>{label} 목록</h3><span>사용 중인 {label}{kind==='position'?'은':'는'} 연결 정보를 변경한 후 삭제할 수 있습니다.</span></header>
      <div className="fleet-org-scroll" role="region" tabIndex={0} aria-label={label+' 표 · 좌우 스크롤'}>
        <table className="fleet-org-table" aria-label={label+' 목록'}><thead><tr><th scope="col">{label} 이름</th><th scope="col">소속 사용자</th><th scope="col">사용 현황</th>{onEdit&&<th scope="col">관리</th>}</tr></thead>
        <tbody>{visible.length===0&&<tr className="fleet-table-empty-row"><td colSpan={onEdit?4:3}><p className="fleet-team-empty">등록된 {label}{kind==='position'?'이':'가'} 없습니다.</p></td></tr>}{visible.map(item=><tr key={item.id} onClick={()=>setSelectedId(item.id)}>
          <td><button type="button" className="fleet-org-name" aria-label={item.name+' '+label+' 상세 보기'}><Icon name="users" size={16}/>{item.name}</button></td>
          <td>{count(item)}</td><td>{status(item)}</td>{onEdit&&<td><button type="button" className="fleet-org-edit" aria-label={item.name+' '+label+' 수정'} onClick={e=>{e.stopPropagation();onEdit(item);}}>수정</button></td>}
        </tr>)}</tbody></table>
      </div>
    </section>}
    {selected&&<BusinessDrawer title={label+' 상세'} subtitle={selected.name} onClose={()=>setSelectedId(null)}>
      <div className="fleet-care-detail"><div className="fleet-care-body"><h3>{label} 정보</h3><dl>
        <div><dt>{label} 이름</dt><dd>{selected.name}</dd></div><div><dt>소속 사용자</dt><dd>{count(selected)}</dd></div><div><dt>상태</dt><dd>{status(selected)}</dd></div>
      </dl></div><footer>{onEdit&&<button type="button" className="business-button is-primary" onClick={()=>{setSelectedId(null);onEdit(selected);}}>수정</button>}<button type="button" className="business-button" onClick={()=>setSelectedId(null)}>닫기</button></footer></div>
    </BusinessDrawer>}
  </div>;
}
