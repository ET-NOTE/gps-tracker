import { useEffect, useState } from 'react';
import Icon from '../Icon';
import { BusinessButton, BusinessEmpty } from './BusinessWorkspace';
import './workspace-mockup-sync.css';

// Desktop design for the rental and freight team screens: the same layout as the corporate
// people, organization, permission group and company screens, fed by each service's own data.

/** 사용자 목록: toolbar with search and action, then a ledger table. */
// `selection` (desktop, managers only): {selected: Set of ids, onToggle(id), onToggleAll()} adds the checkbox
// column; `headAction` sits at the right of the '사용자 N명' head.
export function TeamPeopleLedger({rows, total, query, onQuery, action, extra, filters, caption, selection, headAction}) {
  const allOn=selection&&rows.length>0&&rows.every(r=>selection.selected.has(r.id));
  return <div className="rt-people">
    <div className="rt-toolbar"><label className="rt-search"><Icon name="search" size={15}/><input type="search" aria-label="사용자 검색" placeholder="이름, 이메일 검색" value={query} onChange={e=>onQuery(e.target.value)}/></label>
      {filters}{!filters&&<span className="rt-count">전체 {total}명 중 {rows.length}명</span>}<div className="rt-actions">{action}</div></div>
    <section className="rt-card" aria-label="사용자 목록">{filters&&<header className="rt-card-head rt-ledger-head"><div><h3>사용자 {rows.length}명</h3><p>{caption||'전체 · 전체 '+total+'명'}</p></div>{headAction}</header>}<div className="rt-table-wrap" tabIndex={0} role="region" aria-label="사용자 목록 표"><table className="rt-table">
      <thead><tr>{selection&&<th scope="col" className="rt-check-col"><input type="checkbox" aria-label="현재 목록 전체 선택" checked={allOn} onChange={selection.onToggleAll}/></th>}{['사용자','지점','권한 그룹','계정 상태','수정'].map(label=><th key={label} scope="col">{label}</th>)}</tr></thead>
      <tbody>{rows.length===0&&<tr className="rt-empty-row"><td colSpan={selection?6:5}><div className="mockup-empty"><Icon name="search" size={31}/><strong>사용자를 찾을 수 없습니다.</strong><small>검색어나 조직·상태·권한 조건을 변경해 주세요.</small></div></td></tr>}
        {rows.map(r=><tr key={r.id}>{selection&&<td className="rt-check-col"><input type="checkbox" aria-label={r.name+' 선택'} checked={selection.selected.has(r.id)} onChange={()=>selection.onToggle(r.id)}/></td>}<td><strong>{r.name}</strong><small>{r.email}</small></td><td>{r.branch}</td><td>{r.group}</td>
          <td><span className={'rt-badge '+r.tone}>{r.state}</span></td><td><div className="rt-row-actions">{r.actions}</div></td></tr>)}</tbody>
    </table></div></section>
    {extra}
  </div>;
}

/** 조직·지점 관리: the organization directory with its branch tab. */
export function TeamBranchDirectory({branches, onAdd, onEdit, note='지점에 소속된 사용자와 업무 기록은 지점을 변경한 후 정리할 수 있습니다.'}) {
  return <div className="rt-org">
    <div className="rt-toolbar"><div className="rt-tabs" aria-label="조직 관리 구분"><button type="button" aria-pressed="true">지점<small>{branches.length}</small></button></div>
      <div className="rt-actions">{onAdd&&<button type="button" className="business-button is-primary" onClick={onAdd}><Icon name="plus" size={15}/>지점 추가</button>}</div></div>
    <section className="rt-card" aria-label="지점 관리"><header className="rt-card-head"><h3>지점 목록</h3><span>{note}</span></header>
      <div className="rt-table-wrap" tabIndex={0} role="region" aria-label="지점 표"><table className="rt-table">
        <thead><tr><th scope="col">지점 이름</th><th scope="col">소속 사용자</th><th scope="col">사용 현황</th>{onEdit&&<th scope="col"><span className="rt-visually-hidden">관리</span></th>}</tr></thead>
        <tbody>{branches.length===0&&<tr className="rt-empty-row"><td colSpan={onEdit?4:3}><div className="mockup-empty"><Icon name="search" size={31}/><strong>등록된 지점이 없습니다.</strong><small>지점을 추가해 주세요.</small></div></td></tr>}
          {branches.map(b=><tr key={b.id}><td><strong className="rt-name"><Icon name="mapPin" size={15}/>{b.name}</strong></td><td>{b.members}</td><td>{b.usage}</td>
            {onEdit&&<td><button type="button" className="rt-link" aria-label={b.name+' 지점 수정'} onClick={()=>onEdit(b)}>수정</button></td>}</tr>)}</tbody>
      </table></div></section>
  </div>;
}

/**
 * 권한 그룹: group list on the left and the editor on the right, with permissions shown per menu.
 * `menus` is [[menu label, [[key, label], ...]], ...]; `save({id, name, permissions, revision})`.
 */
export function TeamRoleWorkspace({groups, memberCount, menus, implied={}, save, onMembers}) {
  const [selected,setSelected]=useState(groups[0]?.id??'new');
  const group=groups.find(g=>g.id===selected), creating=selected==='new';
  const [draft,setDraft]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const [created,setCreated]=useState(null);
  // A newly created group is selected once the refreshed list contains it.
  useEffect(()=>{if(created==null)return;const match=groups.find(g=>g.name===created);if(match){setSelected(match.id);setCreated(null);}},[groups,created]);
  useEffect(()=>{setDraft(group?{name:group.name,permissions:[...group.permissions]}:creating?{name:'',permissions:[]}:null);setError('');},[selected,group?.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  const keys=menus.flatMap(([,items])=>items.map(([key])=>key));
  const dirty=draft&&(creating||draft.name.trim()!==group?.name||[...draft.permissions].sort().join()!==[...group.permissions].sort().join());
  function toggle(key){
    setDraft(d=>{const list=new Set(d.permissions);
      if(list.has(key)){list.delete(key);for(const [k,needs] of Object.entries(implied))if(needs.includes(key))list.delete(k);}
      else {list.add(key);for(const need of implied[key]||[])list.add(need);}
      return {...d,permissions:[...list]};});
  }
  async function submit(){
    if(busy||!draft.name.trim())return;
    setBusy(true);setError('');setMessage('');
    try {const id=await save({id:group?.id,name:draft.name.trim(),permissions:draft.permissions,revision:group?.revision});setMessage('권한 그룹을 저장했습니다.');if(id!=null)setSelected(id);else if(creating){setDraft(null);setCreated(draft.name.trim());}}
    catch(e){setError(e.message||'권한 그룹을 저장하지 못했습니다.');}
    finally{setBusy(false);}
  }
  const allOn=draft&&keys.every(k=>draft.permissions.includes(k));
  return <div className="rt-roles">
    <div className="rt-toolbar"><span>권한 그룹 {groups.length}개</span><div className="rt-actions"><BusinessButton primary icon="plus" disabled={busy} onClick={()=>setSelected('new')}>그룹 추가</BusinessButton></div></div>
    <section className="rt-role-panel" aria-label="권한 그룹">
      <div className="rt-role-list" aria-label="권한 그룹 선택"><h3>그룹 목록</h3>
        {groups.map(g=><button key={g.id} type="button" aria-pressed={selected===g.id} onClick={()=>setSelected(g.id)}><span>{g.name}</span><small>{memberCount(g)}명</small></button>)}
        {creating&&<button type="button" aria-pressed="true"><span>새 권한 그룹</span><small>저장 전</small></button>}
        {!groups.length&&!creating&&<BusinessEmpty compact title="등록된 권한 그룹이 없습니다."/>}
      </div>
      {draft&&<div className="rt-role-detail">
        <header><div><h3>{creating?'새 권한 그룹':group.name}</h3><p>변경한 권한은 이 그룹의 사용자에게 함께 적용됩니다.</p></div>
          {group&&onMembers&&<div className="rt-actions"><button type="button" className="business-button" onClick={()=>onMembers(group)}>사용자 보기</button></div>}</header>
        <div className="rt-role-fields"><label>그룹 이름<input value={draft.name} maxLength={80} disabled={busy} onChange={e=>setDraft(d=>({...d,name:e.target.value}))}/></label>
          <label>조회 범위<select value="branch" disabled><option value="branch">담당 지점</option></select></label></div>
        <div className="rt-matrix-head"><h4>메뉴별 권한</h4><button type="button" className="rt-link" disabled={busy} onClick={()=>setDraft(d=>({...d,permissions:allOn?[]:keys}))}>{allOn?'전체 해제':'전체 선택'}</button></div>
        <div className="rt-matrix">{menus.map(([menu,items])=><div key={menu} className="rt-matrix-row"><strong>{menu}</strong><ul>{items.map(([key,label])=>{
          const on=draft.permissions.includes(key);
          return <li key={key}><label><input type="checkbox" checked={on} disabled={busy} onChange={()=>toggle(key)}/><span className="rt-check" aria-hidden="true">{on&&<Icon name="check" size={11}/>}</span>{label}</label></li>;
        })}</ul></div>)}</div>
        <p className="rt-note">수정·작성 권한을 선택하면 해당 항목의 조회 권한도 함께 적용됩니다.</p>
        {error&&<p role="alert" className="rt-error">{error}</p>}{message&&<p role="status" className="rt-note">{message}</p>}
        <footer className="rt-role-actions"><button type="button" className="business-button" disabled={busy||!dirty} onClick={()=>creating?setSelected(groups[0]?.id??'new'):setDraft({name:group.name,permissions:[...group.permissions]})}>{creating?'취소':'되돌리기'}</button>
          <button type="button" className="business-button is-primary" disabled={busy||!dirty||!draft.name.trim()} onClick={submit}>{busy?'저장 중…':'변경사항 저장'}</button></footer>
      </div>}
    </section>
  </div>;
}

/** 회사 정보: the corporate company card. `caption` is the line under the company name. */
export function TeamCompanyCard({name, caption, facts, onEdit}) {
  return <section className="rt-card rt-company" aria-label="회사 정보"><header className="rt-card-head"><h3>회사 정보</h3>{onEdit&&<button type="button" className="business-button rt-small-button" aria-label="회사 정보 수정" onClick={onEdit}><Icon name="pencil" size={12}/>수정</button>}</header>
    <div className="rt-company-line"><span><Icon name="office" size={25}/></span><div><strong>{name||'회사명 미등록'}</strong>{caption&&<small>{caption}</small>}</div></div>
    <dl className="rt-facts">{facts.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value||'미등록'}</dd></div>)}</dl>
  </section>;
}

/**
 * 서비스 이용 현황: plan badge, usage bars and a fact list, like the corporate company page.
 * `bars` is [[label, part, total, unit, note]]; the bar shows part / total. Plan limits are not
 * part of the service, so no "n / limit" is shown.
 */
export function TeamServiceUsage({badge, bars, facts}) {
  return <section className="rt-card rt-usage" aria-label="서비스 이용 현황"><header className="rt-card-head"><div><h3>서비스 이용 현황</h3><p>현재 등록된 차량과 사용자 수입니다.</p></div>{badge}</header>
    {bars.map(([label,part,total,unit,note])=><div key={label} className="fleet-usage-bar"><div><span>{label}</span><strong>{total==null?'—':total+unit}<small>{total?' · '+note+' '+part+unit:''}</small></strong></div>
      <i aria-hidden="true"><b style={{width:(total?100*part/total:0)+'%'}}/></i></div>)}
    <dl className="fleet-usage-facts">{facts.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>;
}
