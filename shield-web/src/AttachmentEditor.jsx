import React, { useEffect, useRef, useState } from "react";
export default function AttachmentEditor({ content, change, onBusy }) {
  const picker = useRef(null),
    controller = useRef(null),
    [error, setError] = useState(""),
    [status, setStatus] = useState("");
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  const files = content.attachments || [];
  async function add(list) {
    if (controller.current) return;
    const items = Array.from(list);
    if (files.length + items.length > 10) {
      setError("첨부파일은 최대 10개까지 넣을 수 있습니다.");
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    onBusy(true);
    setError("");
    try {
      const next = [...files];
      for (let i = 0; i < items.length; i++) {
        const file = items[i];
        if (!file.size || file.size > 5 * 1024 * 1024)
          throw new Error(
            "빈 파일은 제외하고, 파일 한 개당 5MB 이하로 선택해 주세요.",
          );
        setStatus(`첨부파일 ${i + 1}/${items.length} 업로드 중…`);
        const res = await fetch(
          "/api/admin/post-files?" + new URLSearchParams({ name: file.name }),
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "Content-Type": "application/octet-stream" },
            body: file,
            signal: abort.signal,
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok)
          throw new Error(data.error || "파일 업로드에 실패했습니다.");
        abort.signal.throwIfAborted();
        next.push({ id: data.id, title: data.filename, after_step: 0 });
        change("attachments", [...next]);
      }
      setStatus("파일을 추가했습니다. 게시물을 저장하면 반영됩니다.");
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      if (!abort.signal.aborted) {
        controller.current = null;
        onBusy(false);
      }
    }
  }
  return (
    <section className="attachment-editor">
      <h3>첨부파일 · 코드 파일</h3>
      <p className="muted">
        코드(ino, h, hpp, c, cpp, py), 문서(txt, md, json, csv, PDF), ZIP · 각
        5MB 이하 · 최대 10개
      </p>
      <input
        ref={picker}
        type="file"
        hidden
        multiple
        accept=".ino,.h,.hpp,.c,.cpp,.py,.json,.txt,.csv,.md,.pdf,.zip"
        onChange={(e) => {
          add(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        className="outline"
        onClick={() => picker.current.click()}
      >
        ＋ 첨부파일 선택
      </button>
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
          <a className="outline" href={"/api/post-files/" + file.id} download>
            확인
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
