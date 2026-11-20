export const qualityLabels={running:'운행 중',end_missing:'종료 미수신',review:'검토 필요',confirmed:'확정'};
export const qualityLabel=t=>qualityLabels[t.quality?.status]||(t.ended_at?'종료 기록':'종료 미수신');
export const reportIncluded=t=>t.quality?.report_included!==false&&t.allocation_status!=='boundary_review'&&!!t.ended_at&&Number.isFinite(t.distance_m)&&t.distance_m>=0&&new Date(t.ended_at)>new Date(t.started_at);
export const zeroLabels={insufficient_fixes:'GPS 좌표 부족',excluded_segments:'수신 공백·비정상 이동 제외',rounded_short:'50m 미만 · 소수점 반올림',stationary_or_short:'정지 흔들림 제거 후 거리 없음'};
export const endBasisLabels={missing:'종료 신호 없음',sleep_signal:'절전 진입 신호',next_wake:'다음 기상 신호로 구간 구분',gps_interval:'GPS 수신 구간',reviewed:'사용자 확인·보정'};
export const correctionLabels={confirm:'확정',adjust:'시각·거리 보정',split:'분할',merge:'병합'};
export const qualitySummary=trips=>({included:trips.filter(reportIncluded).length,excluded:trips.filter(t=>!reportIncluded(t)).length,confirmedMeters:trips.filter(reportIncluded).reduce((s,t)=>s+t.distance_m,0),unconfirmedMeters:trips.filter(t=>!reportIncluded(t)).reduce((s,t)=>s+(Number.isFinite(t.distance_m)?t.distance_m:0),0)});
export function kstInput(iso){return iso?new Date(new Date(iso).getTime()+9*3600000).toISOString().slice(0,19):'';}
export function tripTimeRange(t){const start=kstInput(t.started_at),end=kstInput(t.ended_at);return `${start.slice(11,16)} ~ ${end?(start.slice(0,10)===end.slice(0,10)?end.slice(11,16):end.replace('T',' ').slice(0,16)):'종료 미수신'}`;}
