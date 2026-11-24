// Bulk user registration for the rental and freight teams: template, CSV checks and result text.
// Each row is later sent to the existing one-person invite API; nothing here talks to the server.
import { csvRecords } from './staffImport.js';

export const teamCsvHeaders = ['이름', '이메일', '지점', '권한 그룹'];
export const teamCsvTemplate = '﻿' + teamCsvHeaders.join(',') + '\r\n';
export const TEAM_IMPORT_LIMIT = 1000;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Reads a template file and checks every row against the loaded team config.
 * Returns {error} for file-level problems, otherwise {rows, problems}: rows carry the resolved
 * branch_id and group_id; problems are [{row, name, reasons}] with 1-based file rows.
 */
export function checkTeamCsv(source, { staff = [], branches = [], groups = [] } = {}) {
  if (new TextEncoder().encode(source).length > 1024 * 1024) return { error: '파일 크기는 1MB 이하여야 합니다.' };
  let records;
  try { records = csvRecords(source); } catch (e) { return { error: e.message }; }
  const header = records.shift();
  if (!header || header.length < 4 || teamCsvHeaders.some((label, i) => header[i] !== label))
    return { error: '등록 서식의 제목 행을 확인해 주세요. 이름·이메일·지점·권한 그룹이 필요합니다.' };
  if (!records.length) return { error: '제목 행 아래에 사용자 정보를 입력해 주세요.' };
  if (records.length > TEAM_IMPORT_LIMIT) return { error: '최대 1,000명씩 나누어 등록해 주세요.' };
  const byName = list => new Map(list.map(item => [String(item.name).trim(), item]));
  const branchNames = byName(branches), groupNames = byName(groups);
  const known = new Set(staff.map(person => String(person.email || '').trim().toLowerCase()).filter(Boolean));
  const seen = new Set(), rows = [], problems = [];
  records.forEach((cells, i) => {
    const [name = '', email = '', branch = '', group = ''] = cells, key = email.toLowerCase(), reasons = [];
    if (!name) reasons.push('이름 없음');
    if (!emailPattern.test(email)) reasons.push('이메일 형식');
    else if (known.has(key) || seen.has(key)) reasons.push('중복 이메일');
    if (!branchNames.has(branch)) reasons.push('등록되지 않은 지점');
    if (!groupNames.has(group)) reasons.push('등록되지 않은 권한 그룹');
    if (emailPattern.test(email)) seen.add(key);
    const row = i + 2;
    if (reasons.length) problems.push({ row, name, reasons });
    else rows.push({ row, name, email, branch, group, branch_id: branchNames.get(branch).id, group_id: groupNames.get(group).id });
  });
  return { rows, problems };
}

/** '3행 · 홍길동: 이메일 형식, 등록되지 않은 지점' lines, six at most, then '외 N개 행'. */
export function problemLines(problems, limit = 6) {
  const lines = problems.slice(0, limit).map(p => `${p.row}행 · ${p.name || '이름 없음'}: ${p.reasons.join(', ')}`);
  if (problems.length > limit) lines.push(`외 ${problems.length - limit}개 행`);
  return lines;
}

/** Final message after one-by-one requests: all succeeded or 'N명 등록, M명 실패'. */
export function importSummary(created, failed) {
  return failed ? `${created}명 등록, ${failed}명 실패` : `${created}명의 사용자를 등록했습니다.`;
}

/** Same wording for applying a permission group to several users. */
export function applySummary(applied, failed) {
  return failed ? `${applied}명 적용, ${failed}명 실패` : `${applied}명에게 권한 그룹을 적용했습니다.`;
}
