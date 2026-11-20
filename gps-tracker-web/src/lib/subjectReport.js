export const subjectScopeNote = '정보주체가 확인한 구간만 표시합니다. 미확인·철회·중지 구간은 제외되며 전체 운행 합계와 다를 수 있습니다.';
export function subjectReport(report, scoped) {
  if (!scoped) return report;
  return {...report, warnings:[subjectScopeNote,...(report.warnings||[])],
    csvPreamble:[[subjectScopeNote],...(report.csvPreamble||[])],
    meta:[subjectScopeNote,...(report.meta||[])],
    footer:[report.footer,subjectScopeNote].filter(Boolean).join('\n')};
}
