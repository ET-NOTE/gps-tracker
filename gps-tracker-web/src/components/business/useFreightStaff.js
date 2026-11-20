import {useEffect,useState} from 'react';
import {api} from '../../api';

export default function useFreightStaff(enabled){
  const [result,setResult]=useState({rows:[],error:''});
  useEffect(()=>{
    if(!enabled)return;
    let active=true;
    api.cargoTeam('GET','/config').then(data=>{
      if(active)setResult({rows:data.staff||[],error:''});
    }).catch(()=>{
      if(active)setResult({rows:[],error:'직원 명단을 불러오지 못했습니다.'});
    });
    return ()=>{active=false;};
  },[enabled]);
  return result;
}
