import React,{useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {api} from '../../api';
import {BusinessError} from './BusinessWorkspace';
import {SkeletonList} from '../ui';
import RentalOfficeCatalog from './RentalOfficeCatalog';
import RentalOfficeBook from './RentalOfficeBook';
import {PeriodFields} from './RentalOfficeKit';
import {initialPeriod,periodOk} from '../../lib/rentalOffice';
import './rental-office.css';
import {officeBookKey,officeCatalogKey} from './rentalOfficeKeys';

const catalogKinds=['customers','accounts','rates','templates'];
export default function RentalOffice({page,devices=[]}) {
  const kind=page.replace(/^rent-/,''),catalogPage=catalogKinds.includes(kind);
  const [period,setPeriod]=useState(initialPeriod);
  const catalog=useQuery({queryKey:officeCatalogKey(catalogPage),queryFn:()=>api.rentalOffice('GET',catalogPage?'/catalog?summary=true':'/catalog'),
    enabled:catalogPage||kind==='payments'});
  const book=useQuery({queryKey:officeBookKey(period),queryFn:()=>api.rentalOffice('GET','/book?'+new URLSearchParams(period)),
    enabled:!catalogPage&&periodOk(period),placeholderData:previous=>previous});
  const fail=(query)=><BusinessError onRetry={query.refetch}>렌트카 관리 정보를 불러오지 못했습니다.</BusinessError>;
  const loading=<SkeletonList count={3} itemHeight={48}/>;
  if (catalogPage) return catalog.isError?fail(catalog):!catalog.data?loading:<RentalOfficeCatalog key={kind} kind={kind} catalog={catalog.data} devices={devices}/>;
  const dates=<PeriodFields period={period} onChange={setPeriod}/>;
  const issue=!periodOk(period)?<p className="ro-error" role="alert">조회 시작일과 종료일을 1년 이내로 선택해 주세요.</p>:
      book.isError?fail(book):kind==='payments'&&catalog.isError?fail(catalog):!book.data||(kind==='payments'&&!catalog.data)?loading:null;
  return <div className="rental-office" aria-busy={book.isFetching}>{issue?<><div className="ro-filters">{dates}</div>{issue}</>:
    <RentalOfficeBook key={kind} kind={kind} period={period} dates={dates} onResetPeriod={()=>setPeriod(initialPeriod())} pending={book.isPlaceholderData} book={book.data} devices={devices} catalog={catalog.data||{accounts:[],customers:[]}}/>}</div>;
}
