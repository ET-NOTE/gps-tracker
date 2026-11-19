import {useId,useState} from 'react';
import Icon from '../Icon';
import './mobile-fleet-directory.css';

export default function MobileFleetDirectory({
  label,filterLabel,filterActive,filters,searchLabel,placeholder,query,onQuery,
  count,createLabel,onCreate,children,
}){
  const [filtersOpen,setFiltersOpen]=useState(false);
  const filtersId=useId();
  return <section className="mobile-fleet-directory" aria-label={label}>
    <div className="mobile-fleet-directory-search">
      <button type="button" className="mobile-fleet-filter-button" aria-expanded={filtersOpen}
        aria-controls={filtersId} onClick={()=>setFiltersOpen(!filtersOpen)}>
        <Icon name="filter" size={16}/>{filterLabel}
        {filterActive&&<span className="mobile-fleet-filter-active" aria-label="적용 중"/>}
      </button>
      <label className="mobile-fleet-search">
        <Icon name="search" size={18}/>
        <input type="search" aria-label={searchLabel} placeholder={placeholder}
          value={query} onChange={e=>onQuery(e.target.value)}/>
      </label>
    </div>
    <div id={filtersId} className="mobile-fleet-filters" hidden={!filtersOpen}>{filters}</div>
    <div className="mobile-fleet-count" role="status">{count}</div>
    {children}
    {onCreate&&<button type="button" className="mobile-fleet-create" onClick={onCreate}>
      <Icon name="plus" size={19}/>{createLabel}
    </button>}
  </section>;
}
