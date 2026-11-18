import {useState} from 'react';
import {BusinessButton,BusinessEmpty} from './BusinessWorkspace';
import './expense-category-settings.css';

export default function ExpenseCategorySettings({categories,canManage,onEdit}){
 const [selectedId,setSelectedId]=useState(null);
 const groups=categories.filter(c=>c.kind==='group');
 const selected=groups.find(g=>g.id===selectedId)||groups[0];
 const children=selected?categories.filter(c=>c.parent_id===selected.id):[];
 return <section className="expense-category-settings" aria-label="지출 항목 관리">
  <header className="expense-category-intro"><h2>지출 항목 관리</h2><p>사용 중지한 항목은 새 지출에서 제외됩니다. 과거 지출의 항목명과 집계는 유지됩니다.</p></header>
  <div className="expense-category-columns">
   <section className="expense-category-groups" aria-label="지출 대분류">
    <header><h3>대분류</h3>{canManage&&<BusinessButton icon="plus" onClick={()=>onEdit({kind:'group',name:'',active:true,parent_id:null})}>추가</BusinessButton>}</header>
    <div className="expense-category-group-list">{groups.map(g=><button className="expense-category-group-option" key={g.id} type="button" aria-pressed={selected?.id===g.id} onClick={()=>setSelectedId(g.id)}><span>{g.name}{!g.active&&<small>사용 중지</small>}</span><span className="expense-category-count">{categories.filter(c=>c.parent_id===g.id).length}</span></button>)}</div>
    {!groups.length&&<BusinessEmpty compact title="등록된 대분류가 없습니다."/>}
   </section>
   <section className="expense-category-items" aria-label="지출 세부 항목">
    <header><h3>{selected?.name||'세부 항목'}{selected&&!selected.active&&<span className="business-badge">사용 중지</span>}</h3>{canManage&&selected&&<div><BusinessButton icon="edit" onClick={()=>onEdit(selected)}>대분류 수정</BusinessButton><BusinessButton icon="plus" disabled={!selected.active} onClick={()=>onEdit({kind:'expense',name:'',active:true,parent_id:selected.id})}>세부 항목 추가</BusinessButton></div>}</header>
    {selected&&<div className="expense-category-table-scroll" role="region" aria-label="지출 항목 목록 · 좌우 스크롤" tabIndex={0}><table><thead><tr><th scope="col">항목명</th><th scope="col">종류</th><th scope="col">상태</th>{canManage&&<th scope="col">관리</th>}</tr></thead><tbody>{children.map(c=><tr key={c.id}><td>{c.name}{c.kind==='fuel'&&<small>승인 시 운행 주유비에 반영</small>}</td><td>{c.kind==='fuel'?'유류비':'일반 비용'}</td><td><span className={`business-badge ${c.active&&selected.active?'good':''}`}>{c.active&&selected.active?'사용 중':'사용 중지'}</span></td>{canManage&&<td><BusinessButton icon="edit" aria-label={`${c.name} 수정`} onClick={()=>onEdit(c)}>수정</BusinessButton></td>}</tr>)}</tbody></table></div>}
    {!children.length&&<BusinessEmpty compact title={selected?'등록된 세부 항목이 없습니다.':'대분류를 먼저 추가하세요.'}/>}
   </section>
  </div>
 </section>;
}
