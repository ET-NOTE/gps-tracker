import {reportIncluded,qualityLabel,tripTimeRange} from './tripQuality.js';
import { kstDateTime, safeFilename } from './businessExport.js';

const text = value => typeof value === 'string' ? value.trim() : '';
const km = value => Math.round(value / 10) / 100;
const distance = trip => typeof trip.distance_m === 'number' && Number.isFinite(trip.distance_m) && trip.distance_m >= 0 ? km(trip.distance_m) : null;
const odometerReading = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 9999999.99 && Math.abs(value * 100 - Math.round(value * 100)) <= 0.000001;
// Use only a complete, valid measured pair. Never reconstruct readings from GPS.
const odometer = trip => {
  const before = trip.annotation?.odometer_before_km, after = trip.annotation?.odometer_after_km;
  return odometerReading(before) && odometerReading(after) && after >= before
    ? {before, after, km:Math.round((after - before) * 100) / 100} : null;
};
export function reportVehicleLabel(device) {
  const identity = [text(device?.vehicle_name || device?.car_model), text(device?.car_plate || device?.license_plate)].filter(Boolean);
  if(identity.every(v=>v==='차량 정보 미등록')) return `차량 정보 미등록 · ${device?.primary_terminal_name || device?.display_name || '차량 #' + device?.id}`;
  return identity.length ? identity.join(' · ') : `차량 정보 미등록 · ${device?.display_name || '단말기 ' + (device?.id ?? '')}`;
}

function tripFilename(device, model, plate, from, to) {
  const prefix = '업무용승용차_운행기록부_';
  const period = `_${from}_${to}`;
  const name = safeFilename(text(device?.vehicle_name) || text(device?.asset?.name) || model || '차종미등록');
  const registration = safeFilename(plate || `차량번호미등록_${device?.id ?? ''}`);
  // saveBlob limits the stem to 60 Unicode characters. Reserve space for both
  // identifiers and the full period before long user-entered names are clipped.
  const available = 60 - prefix.length - period.length;
  if (name === registration) return prefix + [...name].slice(0, available).join('') + period;
  const nameChars = [...name];
  const identitySpace = available - 1;
  const maxPlate = Math.max(Math.floor(identitySpace / 2), identitySpace - nameChars.length);
  const plateChars = [...registration].slice(0, maxPlate);
  const namePart = nameChars.slice(0, identitySpace - plateChars.length).join('');
  return `${prefix}${namePart}_${plateChars.join('')}${period}`;
}

// Column order follows the supplied "운행기록부 폼" sheet, B12:Q14.
// Staff department and measured odometer readings come from the saved annotation.
// A GPS sum and a vehicle's department are not substitutes for those fields.
export function ntsTripReport(trips, { device, info, from, to, filtered = false } = {}) {
  const plate = text(device?.car_plate || device?.license_plate), model = text(device?.car_model);
  const warnings = [];
  const missing = [[info?.company_name,'법인명'],[info?.business_number,'사업자등록번호'],[plate,'자동차등록번호'],[model,'차종']].filter(([v])=>!text(v)).map(([,label])=>label);
  if (missing.length) warnings.push(`차량·회사 정보 미입력: ${missing.join(', ')}`);
  if (trips.length) warnings.push('사용자란은 차량 이용자 기준입니다. 표시된 운전자와 이용자가 다르면 성명·부서를 수정해 주세요.');
  const measured = trips.map(odometer);
  const odometerCount = measured.filter(Boolean).length;
  const recordDistanceCount = trips.filter((t,i)=>!measured[i] && distance(t) !== null).length;
  const missingDistanceCount = trips.length - odometerCount - recordDistanceCount;
  const missingOdometerCount = trips.length - odometerCount;
  const distanceBasis = `⑦거리 기준: 계기판 차이(⑥−⑤) ${odometerCount}건 · 운행기록 거리 대체 ${recordDistanceCount}건${missingDistanceCount ? ` · 거리 확인 필요 ${missingDistanceCount}건` : ''}`;
  if (missingOdometerCount) warnings.push(`계기판 거리 미입력·확인 필요 ${missingOdometerCount}건은 ⑤⑥을 공란으로 두고, 유효한 운행기록 거리가 있으면 ⑦에 대체 표시합니다. 실제 기록을 확인해 주세요.`);
  if (trips.length) warnings.push('대체·참고 값은 GPS 계산 또는 검토·보정된 운행기록 거리입니다. 계기판 실제 기록과 다를 수 있습니다.');
  if (trips.length) warnings.push('부서는 운전자 배정 시점의 값을 사용합니다. 계기판 입력만으로 미확정 운행을 합계에 포함하지 않습니다.');
  const incomplete = trips.filter(t=>!reportIncluded(t) || !t.ended_at || !kstDateTime(t.ended_at) || distance(t) === null || !kstDateTime(t.started_at) || new Date(t.ended_at) < new Date(t.started_at));
  const excluded = new Set(incomplete);
  const unassigned = trips.filter(t=>!['business','commute','other'].includes(t.annotation?.purpose));
  const missingDriver = trips.filter(t=>!text(t.annotation?.driver_name));
  if (incomplete.length) warnings.push(`미확정·종료·거리·사용일자 확인이 필요한 운행 ${incomplete.length}건은 합계에서 제외합니다.`);
  if (unassigned.length) warnings.push(`용무 미지정 ${unassigned.length}건이 있어 업무 사용비율을 계산하지 않습니다.`);
  if (missingDriver.length) warnings.push(`사용자 성명 미지정 ${missingDriver.length}건`);
  if (filtered) warnings.push('현재 필터에 해당하는 운행만 포함합니다. 기간 전체 합계가 아닙니다.');
  const rows = trips.map((t,i) => {
    const started = kstDateTime(t.started_at), day = started.slice(0,10), recorded = distance(t), reading = measured[i], value = reading?.km ?? recorded;
    const purpose = t.annotation?.purpose, valid = !excluded.has(t);
    const classified = valid && ['commute','business','other'].includes(purpose);
    const basisNote = reading ? `계기판 차이 적용${recorded !== null && recorded !== reading.km ? ` · 운행기록 거리 참고 ${recorded.toFixed(2)} km` : ''}`
      : `계기판 미입력·확인 필요 · ${recorded === null ? '운행기록 거리 확인 필요' : '운행기록 거리 기준'}`;
    const note = [!valid && '미확정·종료·거리·일자 확인 필요 · 합계 제외', basisNote, !text(t.annotation?.driver_name) && '성명 미지정', !['business','commute','other'].includes(purpose) && '용무 미지정',
      t.allocation_note, t.correction_id && `보정 #${t.correction_id}`, t.quality && qualityLabel(t), t.annotation?.purpose_note, t.annotation?.note, started && tripTimeRange(t)].filter(Boolean).join(' / ');
    return {date: day ? `${day} (${'일월화수목금토'[new Date(`${day}T00:00:00Z`).getUTCDay()]})` : '', department:text(t.annotation?.driver_department), driver:text(t.annotation?.driver_name), before:reading?.before ?? '', after:reading?.after ?? '',
      km:value ?? '', commute:classified ? (purpose==='commute' ? value : 0) : '',
      business:classified ? (purpose==='business' ? value : 0) : '', note};
  });
  // Sum the exported rounded values so visible rows and totals agree.
  const sum = key => Math.round(rows.reduce((s,r,i)=>s + (excluded.has(trips[i]) ? 0 : Number(r[key]) || 0),0)*100)/100;
  const total = sum('km'), commute = sum('commute'), business = sum('business'), work = Math.round((commute+business)*100)/100;
  const ratio = total > 0 && !incomplete.length && !unassigned.length ? `${(100*work/total).toFixed(2)}%` : '';
  const columns = [
    ['date','③사용일자 (요일)'],['department','④사용자 부서'],['driver','④사용자 성명'],
    ['before','⑤주행 전 계기판 거리(㎞)'],['after','⑥주행 후 계기판 거리(㎞)'],['km','⑦주행거리(㎞)'],
    ['commute','⑧출·퇴근용(㎞)'],['business','⑨일반 업무용(㎞)'],['note','⑩비고'],
  ].map(([key,label])=>({key,label,pdfLabel:({date:'3 사용일자 (요일)',department:'4 사용자\n부서',driver:'4 사용자\n성명',before:'5 주행 전\n계기판(km)',after:'6 주행 후\n계기판(km)',km:'7 주행거리\n(km)',commute:'8 출·퇴근용\n(km)',business:'9 일반 업무용\n(km)',note:'10 비고'})[key],numeric:['before','after','km','commute','business'].includes(key),pdfWidth:({date:80,department:48,driver:48,before:62,after:62,km:55,commute:55,business:55,note:'*'})[key]}));
  return {title:'업무용승용차 운행기록부', filename:tripFilename(device, model, plate, from, to),
    columns, rows, warnings,
    printForm:{kind:'nts-trip-log',company:text(info?.company_name),businessNumber:text(info?.business_number),model,plate,from,to,filtered,
      total,commute,business,work,ratio,distanceBasis,odometerCount,recordDistanceCount,missingDistanceCount,missingOdometerCount,includedCount:trips.length-incomplete.length,excludedCount:incomplete.length,excludedRows:trips.map(t=>excluded.has(t))},
    meta:[`법인명: ${text(info?.company_name)||'미등록'} · 사업자등록번호: ${text(info?.business_number)||'미등록'}`,`차량: ${model||'미등록'} · ${plate||'미등록'} · 기간: ${from} ~ ${to}`, `국세청 고시 제2025-8호 별지 항목 기준 · ${distanceBasis}`,...warnings],
    footer:`⑪조회 내역 총주행거리: ${total} km · ⑫업무용 사용거리: ${work} km · ⑬업무사용비율: ${ratio||'미계산'}\n조회기간이 전체 사업연도인지 확인하고 거리 기준·사용자 정보를 확인해 주세요.`,
    pdfFooter:`11 조회 내역 총주행거리: ${total} km · 12 업무용 사용거리: ${work} km · 13 업무사용비율: ${ratio||'미계산'}\n조회기간이 전체 사업연도인지 확인하고 거리 기준·사용자 정보를 확인해 주세요.`,
    csvPreamble:[['업무용승용차 운행기록부'],['조회기간',from,to],['법인명',text(info?.company_name)],['사업자등록번호',text(info?.business_number)],
      ['①차종',model],['②자동차등록번호',plate],['자료 기준',`첨부 서식의 항목 순서 · ${distanceBasis}`],
      ['조회 범위',filtered?'필터 적용 내역':'선택 차량·조회기간 내역'],...warnings.map(w=>['보완 사항',w]),[]],
    csvFooter:[[],['조회 내역 합계','','','','',total,commute,business,'종료·거리·일자가 확인된 운행만 합산'],
      ['⑪조회 내역 총주행거리(㎞)',total],['⑫조회 내역 업무용 사용거리(㎞)',work],['⑬업무사용비율(⑫/⑪)',ratio],
      ['안내','조회기간이 전체 사업연도인지 확인해 주세요. 거리 기준·사용자 정보와 위 보완 사항을 확인 후 사용하세요.']],
    summary:`${rows.length}건 · 합계 ${total.toFixed(2)} km`};
}
