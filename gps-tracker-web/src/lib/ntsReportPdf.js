// Print layout based on the supplied 운행기록부 폼. Calculation and filtering
// stay in ntsTripReport; a PDF must not recalculate or invent odometer readings.
const value = v => typeof v === 'number' ? v.toLocaleString('ko-KR', {maximumFractionDigits:2}) : String(v ?? '');
const grid = {
  hLineWidth: () => 0.5, vLineWidth: () => 0.5,
  hLineColor: () => '#68717c', vLineColor: () => '#68717c',
  paddingLeft: () => 3, paddingRight: () => 3,
  paddingTop: () => 5, paddingBottom: () => 5,
};
const heading = (text, extra = {}) => ({text, bold:true, alignment:'center', fillColor:'#f0f2f4', ...extra});
const section = text => ({text, bold:true, fontSize:11, margin:[0,12,0,6]});

export function ntsReportPdfDefinition(report) {
  const f = report.printForm;
  const detailNotes = [];
  const rows = report.rows.map((r, i) => {
    // Preserve long/free-form notes in a flowing appendix instead of shrinking
    // the grid or dropping content. Even one very long note can span pages.
    const extended = String(r.note || '').length > 100 || String(r.note || '').includes('\n');
    if (extended) detailNotes.push({index:i + 1, date:r.date, note:r.note});
    return report.columns.map(c => ({
      text:c.key === 'date' ? value(r.date).replace(' (','\n(')
        : c.key === 'note' && extended ? `${f.excludedRows[i] ? '합계 제외 · ' : ''}상세 비고 ${i + 1} 참조` : value(r[c.key]),
      alignment:c.numeric ? 'right' : c.key === 'date' ? 'center' : 'left',
      fillColor:f.excludedRows[i] ? '#f7f7f7' : null,
    }));
  });
  const headers = [
    [heading('3 사용일자\n(요일)',{rowSpan:3}), heading('4 사용자',{colSpan:2}), {}, heading('운행 내역',{colSpan:6}), {}, {}, {}, {}, {}],
    [{}, heading('부서',{rowSpan:2}), heading('성명',{rowSpan:2}), heading('5 주행 전\n계기판 거리\n(km)',{rowSpan:2}), heading('6 주행 후\n계기판 거리\n(km)',{rowSpan:2}), heading('7 주행거리\n(km)',{rowSpan:2}), heading('업무용 사용거리 (km)',{colSpan:2}), {}, heading('10 비고',{rowSpan:2})],
    [{},{},{},{},{},{},heading('8 출·퇴근용'),heading('9 일반 업무용'),{}],
  ];
  const table = {table:{headerRows:3, keepWithHeaderRows:1, dontBreakRows:true,
    widths:[78,52,50,66,66,53,57,57,'*'],
    body:[...headers, ...(rows.length ? rows : [[{text:'조건에 맞는 운행 내역이 없습니다.',colSpan:9,alignment:'center',margin:[0,12,0,12]},{},{},{},{},{},{},{},{}]]),
      [{text:`조회 내역 합계 · 포함 ${f.includedCount}건 / 제외 ${f.excludedCount}건`,colSpan:5,bold:true},{},{},{},{},
        ...[f.total,f.commute,f.business].map(n=>({text:value(n),alignment:'right',bold:true})),{text:'합계 제외 기록은 더하지 않음',fontSize:8}]],
  },layout:grid};
  return {
    pageSize:'A4',pageOrientation:'landscape',pageMargins:[30,30,30,38],
    info:{title:report.title,author:'GPS 차량 운영'},
    defaultStyle:{font:'NanumGothic',fontSize:9,color:'#18222e',lineHeight:1.15},
    footer:(page,pages)=>({columns:[{text:`${f.plate || '차량번호 미등록'} · ${f.from} ~ ${f.to}`},{text:`${page} / ${pages}`,alignment:'right'}],fontSize:8,color:'#58616d',margin:[30,13,30,0]}),
    content:[
      {table:{widths:[57,118,'*',82,156],body:[
        [heading('조회기간',{rowSpan:2}),{text:`${f.from}\n~ ${f.to}`,rowSpan:2,alignment:'center'},
          {text:report.title,rowSpan:2,bold:true,fontSize:17,alignment:'center',margin:[0,5,0,0]},heading('상호명'),{text:f.company}],
        [{},{},{},heading('사업자등록번호'),{text:f.businessNumber}],
      ]},layout:grid},
      section('1. 기본정보'),
      {table:{widths:[75,'*',108,'*'],body:[[heading('1 차종'),{text:f.model},heading('2 자동차등록번호'),{text:f.plate}]]},layout:grid},
      section('2. 업무용 사용비율 계산'),
      {text:`${f.filtered ? '필터 적용 내역' : '선택 차량·조회기간 내역'} · ${report.rows.length}건 · 거리: GPS 계산값 · 주행 전·후 계기판: 실제 기록 보완`,fontSize:8,color:'#58616d',margin:[0,0,0,6]},
      table,
      {unbreakable:true,margin:[0,10,0,0],stack:[
        {table:{widths:['*','*','*'],body:[
          [heading('11 조회 내역 총주행거리 (km)'),heading('12 조회 내역 업무용 사용거리 (km)'),heading('13 업무사용비율 (12 / 11)')],
          [f.total,f.work,f.ratio || '미계산'].map(n=>({text:value(n),alignment:'center',bold:true,fontSize:11})),
        ]},layout:grid},
        {text:'합계는 선택한 기간과 필터 기준입니다. 과세기간 전체 합계로 사용하려면 조회 범위와 누락 정보를 확인해 주세요.',fontSize:8,color:'#58616d',margin:[0,6,0,0]},
      ]},
      ...(report.warnings.length ? [section('작성 시 확인할 사항'),{ul:report.warnings.map(text=>({text,margin:[0,0,0,3]})),fontSize:8,color:'#444d58'}] : []),
      ...(detailNotes.length ? [{text:'상세 비고',bold:true,fontSize:14,pageBreak:'before',margin:[0,0,0,10]},
        ...detailNotes.flatMap(n=>[
          {text:`${n.index} · ${n.date || '사용일자 미확인'}`,bold:true,margin:[0,8,0,4]},
          {text:n.note,fontSize:9,margin:[0,0,0,10]},
        ])] : []),
    ],
  };
}
