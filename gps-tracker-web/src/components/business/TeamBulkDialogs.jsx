import { useRef, useState } from 'react';
import { Modal } from '../ui';
import Icon from '../Icon';
import { checkTeamCsv, importSummary, applySummary, problemLines, teamCsvTemplate } from '../../lib/teamImport';
import { saveBlob } from '../../lib/fileDownload';

// Desktop design dialogs for the rental and freight user lists. Both send the existing one-person
// requests in order; a failed row does not stop the rest and saved rows are kept.

const csvCell = value => /[",\r\n]/.test(value) ? '"' + String(value).replaceAll('"', '""') + '"' : String(value);

/** 사용자 일괄 등록: template, file check with a preview, then one invite request per row. */
export function TeamBulkImport({ data, invite, onClose, onDone }) {
  const [check, setCheck] = useState(null), [error, setError] = useState(''), [progress, setProgress] = useState(null), [result, setResult] = useState(null);
  const running = useRef(false), busy = progress != null && !result;
  async function choose(file) {
    setCheck(null); setError(''); setResult(null);
    if (!file) return;
    if (file.size > 1024 * 1024) { setError('파일 크기는 1MB 이하여야 합니다.'); return; }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer()); }
    catch { setError('CSV UTF-8 형식으로 저장한 파일을 선택해 주세요.'); return; }
    const checked = checkTeamCsv(text, data);
    if (checked.error) setError(checked.error); else setCheck(checked);
  }
  async function register() {
    if (running.current || !check?.rows.length || check.problems.length) return;
    running.current = true;
    const created = [], failed = [];
    setProgress(0);
    for (const row of check.rows) {
      try {
        const response = await invite({ name: row.name, email: row.email, branch_id: row.branch_id, group_id: row.group_id });
        created.push({ ...row, code: response?.code || '' });
      } catch (e) { failed.push({ ...row, reason: e.message || '등록하지 못했습니다.' }); }
      setProgress(created.length + failed.length);
    }
    running.current = false;
    setResult({ created, failed });
    onDone();
  }
  function downloadCodes() {
    const lines = [['이름', '이메일', '초대 코드'], ...result.created.map(r => [r.name, r.email, r.code])];
    saveBlob(new Blob(['﻿' + lines.map(line => line.map(csvCell).join(',')).join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }), '사용자_초대_코드.csv');
  }
  const ready = check && !check.problems.length;
  return <Modal open size="lg" title="사용자 일괄 등록" subtitle="등록 서식에 사용자 정보를 작성한 후 파일을 선택하세요." onClose={busy ? undefined : onClose}>
    <div className="rt-import">
      {!result && <>
        <div className="rt-import-head"><p>지점·권한 그룹은 등록된 이름을 사용합니다.</p>
          <button type="button" className="business-button" disabled={busy} onClick={() => saveBlob(new Blob([teamCsvTemplate], { type: 'text/csv;charset=utf-8' }), '사용자_등록_서식.csv')}><Icon name="download" size={14}/>서식 다운로드</button></div>
        <label className="rt-import-file">CSV 파일<input type="file" accept=".csv,text/csv" disabled={busy} onChange={e => choose(e.target.files?.[0])}/></label>
        <p className="rt-import-note">한 번에 최대 1,000명까지 등록할 수 있습니다.</p>
      </>}
      <div className="rt-import-preview" aria-live="polite">
        {error ? <p role="alert" className="rt-import-warn">{error}</p>
          : result ? <><p className={result.failed.length ? 'rt-import-warn' : 'rt-import-ok'}>{importSummary(result.created.length, result.failed.length)}</p>
            {result.failed.length > 0 && <ul>{result.failed.map(r => <li key={r.row}>{r.row}행 · {r.name}: {r.reason}</li>)}</ul>}
            {result.created.length > 0 && <p className="rt-import-note">초대 코드는 이 창에서만 확인할 수 있습니다. 필요하면 내려받아 전달해 주세요.</p>}</>
          : busy ? <p>{progress} / {check.rows.length}명 등록 중</p>
          : !check ? <p>파일을 선택하면 등록할 사용자와 확인이 필요한 항목이 표시됩니다.</p>
          : check.problems.length ? <><p className="rt-import-warn">확인이 필요한 {check.problems.length}개 행을 수정한 후 다시 선택해 주세요.</p><ul>{problemLines(check.problems).map(line => <li key={line}>{line}</li>)}</ul></>
          : <><p className="rt-import-ok">등록 준비 완료 <span className="rt-badge good">{check.rows.length}명</span></p>
            <ul>{check.rows.slice(0, 5).map(r => <li key={r.row}><strong>{r.name}</strong> {r.email} · {r.branch} · {r.group}</li>)}</ul>
            {check.rows.length > 5 && <p>외 {check.rows.length - 5}명</p>}</>}
      </div>
      <div className="rt-import-actions">
        {result ? <>{result.created.length > 0 && <button type="button" className="business-button" onClick={downloadCodes}><Icon name="download" size={14}/>초대 코드 내려받기</button>}
          <button type="button" className="business-button is-primary" onClick={onClose}>닫기</button></>
          : <><button type="button" className="business-button" disabled={busy} onClick={onClose}>취소</button>
            <button type="button" className="business-button is-primary" disabled={!ready || busy} onClick={register}>일괄 등록</button></>}
      </div>
    </div>
  </Modal>;
}

/** 권한 그룹 적용: one group for the selected users, saved with the existing per-user update. */
export function TeamRoleApply({ people, groups, update, onClose, onDone }) {
  const shared = people.every(p => p.group_id === people[0]?.group_id) ? String(people[0]?.group_id ?? '') : '';
  const [group, setGroup] = useState(shared), [progress, setProgress] = useState(null), [result, setResult] = useState(null);
  const running = useRef(false), busy = progress != null && !result;
  async function apply() {
    if (running.current || !group) return;
    running.current = true;
    let applied = 0; const failed = [];
    setProgress(0);
    for (const person of people) {
      try { await update(person, Number(group)); applied++; }
      catch (e) { failed.push({ name: person.name, reason: e.message || '적용하지 못했습니다.' }); }
      setProgress(applied + failed.length);
    }
    running.current = false;
    setResult({ applied, failed });
    onDone();
  }
  const subtitle = people.length === 1 ? `${people[0].name}에게 적용할 권한 그룹을 선택하세요.` : `${people.length}명의 사용자에게 적용할 권한 그룹을 선택하세요.`;
  return <Modal open size="md" title="권한 그룹 적용" subtitle={subtitle} onClose={busy ? undefined : onClose}>
    <div className="rt-import">
      {!result && <label className="rt-import-file">권한 그룹<select aria-label="권한 그룹" value={group} disabled={busy} onChange={e => setGroup(e.target.value)}>
        {!shared && <option value="">권한 그룹 선택</option>}{groups.map(g => <option key={g.id} value={String(g.id)}>{g.name}</option>)}</select></label>}
      <div className="rt-import-preview" aria-live="polite">
        {result ? <><p className={result.failed.length ? 'rt-import-warn' : 'rt-import-ok'}>{applySummary(result.applied, result.failed.length)}</p>
          {result.failed.length > 0 && <ul>{result.failed.map(f => <li key={f.name}>{f.name}: {f.reason}</li>)}</ul>}</>
          : busy ? <p>{progress} / {people.length}명 적용 중</p>
          : <p>선택한 그룹의 현재 권한이 적용됩니다. 이후 그룹 권한을 변경하면 함께 반영됩니다.</p>}
      </div>
      <div className="rt-import-actions">
        {result ? <button type="button" className="business-button is-primary" onClick={onClose}>닫기</button>
          : <><button type="button" className="business-button" disabled={busy} onClick={onClose}>취소</button>
            <button type="button" className="business-button is-primary" disabled={!group || busy} onClick={apply}>그룹 적용</button></>}
      </div>
    </div>
  </Modal>;
}
