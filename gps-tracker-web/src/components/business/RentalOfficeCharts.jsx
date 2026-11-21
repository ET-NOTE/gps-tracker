import {useEffect,useRef} from 'react';
import {won} from '../../lib/rentalOffice';
import {ChartPanel,ReportBars} from './OperationsChart';

function RevenueLine({figures,period}) {
  const ref=useRef(null);
  useEffect(()=>{
    const canvas=ref.current;
    if(!canvas) return;
    const totals=new Map(figures.map(r=>[r.id,r.payment-r.refund]));
    const amounts=[];
    for(let day=Date.parse(period.from);day<=Date.parse(period.to);day+=86400000) {
      amounts.push(totals.get(new Date(day).toISOString().slice(0,10))||0);
    }
    function paint() {
      const {width,height}=canvas.getBoundingClientRect();
      if(!width||!height||!amounts.length)return;
      const ratio=window.devicePixelRatio||1;
      canvas.width=Math.round(width*ratio);canvas.height=Math.round(height*ratio);
      const ctx=canvas.getContext('2d');if(!ctx)return;
      ctx.scale(ratio,ratio);
      const style=getComputedStyle(canvas),left=54,right=12,top=15,bottom=26;
      const low=Math.min(0,...amounts),high=Math.max(1,...amounts);
      const x=i=>left+(width-left-right)*i/Math.max(1,amounts.length-1);
      const y=v=>top+(height-top-bottom)*(high-v)/(high-low);
      ctx.font='12px sans-serif';ctx.textAlign='right';
      for(const value of [...new Set([low,0,Math.round((high+low)/2),high])]) {
        ctx.fillStyle=style.color;
        ctx.fillText(new Intl.NumberFormat('ko',{notation:'compact',maximumFractionDigits:1}).format(value),left-7,y(value)+4);
        ctx.strokeStyle=style.getPropertyValue('--border').trim()||'#e4eaf1';
        ctx.beginPath();ctx.moveTo(left,y(value));ctx.lineTo(width-right,y(value));ctx.stroke();
      }
      ctx.beginPath();ctx.lineWidth=2;ctx.strokeStyle=style.getPropertyValue('--primary').trim()||'#377bd9';
      amounts.forEach((v,i)=>{if(i)ctx.lineTo(x(i),y(v));else ctx.moveTo(x(i),y(v));});ctx.stroke();
      if(amounts.length<=31){ctx.fillStyle=ctx.strokeStyle;amounts.forEach((v,i)=>{ctx.beginPath();ctx.arc(x(i),y(v),2.4,0,2*Math.PI);ctx.fill();});}
      ctx.fillStyle=style.color;ctx.textAlign='left';ctx.fillText(period.from.slice(5),left,height-4);
      if(period.from!==period.to){ctx.textAlign='right';ctx.fillText(period.to.slice(5),width-right,height-4);}
    }
    const observer=new ResizeObserver(paint);observer.observe(canvas);paint();
    return ()=>observer.disconnect();
  },[figures,period]);
  return <ChartPanel title="기간별 대여료 수납" subtitle="결제 기록에서 환불을 차감한 금액">
    {figures.some(r=>r.payment||r.refund)?<canvas ref={ref} style={{height:175}} role="img" aria-label={'일별 순수납 추이. 조회 기간 합계 '+won(figures.reduce((s,r)=>s+r.payment-r.refund,0))+'. 일별 수치는 아래 표에서 확인할 수 있습니다.'}/>:
      <p className="ops-chart-empty" style={{height:175}}>조회 기간에 이용료 수납·환불 기록이 없습니다.</p>}</ChartPanel>;
}
export default function RentalOfficeCharts({figures,groups,period}) {
  return <div className="ops-report-grid"><RevenueLine figures={figures} period={period}/>
    <ChartPanel title="차종별 계약 건수"><ReportBars values={groups.map(g=>({label:g.id,value:g.contracts.length}))} unit="건" height={175}/></ChartPanel></div>;
}
