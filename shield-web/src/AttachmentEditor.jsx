import React, { useEffect, useRef, useState } from "react";
import { request } from "./api";
export default function AttachmentEditor({ content, change, onBusy }) {
  const controller = useRef(null),
    [error, setError] = useState(""),
    [status, setStatus] = useState(""),
    [url, setUrl] = useState(""),
    [filename, setFilename] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const files = content.attachments || [];
  async function add() {
    if (controller.current) return;
    if (files.length >= 10) {
      setError("첨부파일은 최대 10개까지 넣을 수 있습니다.");
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    onBusy(true);
    setBusy(true);
    setError("");
    setStatus("");
    try {
      const data = await request("/admin/post-files/drive", {
        method: "POST", body: { url: url.trim(), filename: filename.trim() }, signal: abort.signal,
      });
      abort.signal.throwIfAborted();
      if (files.some(f => f.id === data.id)) throw new Error("이미 첨부한 파일입니다.");
      change("attachments", [...files, { id: data.id, title: filename.trim(), after_step: 0 }]);
      setUrl("");
      setFilename("");
      setStatus("Drive 링크를 추가했습니다. 게시물을 저장하면 반영됩니다.");
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      if (!abort.signal.aborted) {
        controller.current = null;
        onBusy(false);
        setBusy(false);
      }
    }
  }
  return (
    <section className="attachment-editor">
      <h3>첨부파일 · 코드 파일</h3>
      <p className="muted">
        파일을 Google Drive에 올리고 공유를 ‘링크가 있는 모든 사용자 · 뷰어’로 설정한 뒤
        파일 링크를 추가하세요. 최대 10개까지 첨부할 수 있습니다.
      </p>
      <div className="drive-attachment-form">
        <label>파일 이름 (확장자 포함)
          <input value={filename} onChange={e => setFilename(e.target.value)} maxLength={120}
            placeholder="예: first-upload.zip" disabled={busy} />
        </label>
        <label>Google Drive 파일 공유 링크
          <input value={url} onChange={e => setUrl(e.target.value)} maxLength={1000}
            inputMode="url" placeholder="https://drive.google.com/file/d/…/view" disabled={busy} />
        </label>
        <button type="button" className="outline" onClick={add}
          disabled={busy || !filename.trim() || !url.trim() || files.length >= 10}>
          {busy ? "추가 중…" : "＋ Drive 파일 추가"}
        </button>
      </div>
      <p className="muted">무료 공개 자료만 연결하세요. 시크릿 창에서 파일을 열어 다운로드 권한을 확인해 주세요.
        게시물을 숨겨도 Drive의 공유 권한은 별도로 유지됩니다.</p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {status && (
        <p className="notice" role="status">
          {status}
        </p>
      )}
      {files.map((file, i) => (
        <div className="attachment-row" key={`${file.id}-${i}`}>
          <label>
            다운로드 이름
            <input
              required
              maxLength={120}
              value={file.title}
              onChange={(e) =>
                change(
                  "attachments",
                  files.map((f, j) =>
                    j === i ? { ...f, title: e.target.value } : f,
                  ),
                )
              }
            />
          </label>
          <label>
            표시 위치
            <select
              value={file.after_step}
              onChange={(e) =>
                change(
                  "attachments",
                  files.map((f, j) =>
                    j === i ? { ...f, after_step: Number(e.target.value) } : f,
                  ),
                )
              }
            >
              <option value="0">모든 단계</option>
              {content.steps.map((_, j) => (
                <option key={j} value={j + 1}>
                  {j + 1}단계
                </option>
              ))}
            </select>
          </label>
          <a className="outline" href={"/api/post-files/" + file.id} target="_blank" rel="noopener noreferrer">
            파일 확인 ↗
          </a>
          <button
            type="button"
            onClick={() =>
              change(
                "attachments",
                files.filter((_, j) => i !== j),
              )
            }
          >
            파일 빼기
          </button>
        </div>
      ))}
    </section>
  );
}
