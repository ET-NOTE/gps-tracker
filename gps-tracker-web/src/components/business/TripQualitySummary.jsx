import React from 'react';
import {qualitySummary} from '../../lib/tripQuality';

export default function TripQualitySummary({trips,loading,error,vehicleSelected=true,onlyReview,onReviewChange}){
  if(!vehicleSelected)return <div className="fleet-quality-summary" role="status">차량을 선택하면 운행 요약이 표시됩니다.</div>;
  if(loading||!trips&&!error)return <div className="fleet-quality-summary" role="status" aria-busy="true">운행 상태를 불러오는 중…</div>;
  if(error)return <div className="fleet-quality-summary" role="status">조회 후 운행 요약이 표시됩니다.</div>;
  const total=qualitySummary(trips);
  return <div className="fleet-quality-summary"><strong>확정 {total.included}건 · {(total.confirmedMeters/1000).toFixed(2)} km</strong><span>합계 제외 {total.excluded}건 · 관측 거리 {(total.unconfirmedMeters/1000).toFixed(2)} km</span><label className="no-print"><input type="checkbox" checked={onlyReview} onChange={e=>onReviewChange(e.target.checked)}/>미확정만 보기</label><span className="business-note">미확정 기록은 목록·내보내기에 표시하되 거리 합계에서 제외합니다.</span></div>;
}
