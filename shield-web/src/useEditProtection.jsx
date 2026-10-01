import React, { useEffect, useRef, useState } from "react";
import { useBlocker } from "react-router-dom";

// Router navigation (including Back) and local editor changes use the same prompt.
export default function useEditProtection({ dirty, busy }) {
  const blocker = useBlocker(dirty || busy);
  const [pending, setPending] = useState(null);
  const dialog = useRef(null);
  const open = !!pending || blocker.state === "blocked";
  useEffect(() => {
    if (!dirty && !busy) return;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, busy]);
  useEffect(() => {
    if (!dialog.current) return;
    if (open && !dialog.current.open) dialog.current.showModal();
    else if (!open && dialog.current.open) dialog.current.close();
  }, [open]);
  const stay = () => {
    setPending(null);
    if (blocker.state === "blocked") blocker.reset();
  };
  const leave = (action) => {
    if (dirty || busy) setPending(() => action);
    else action();
  };
  const proceed = () => {
    if (busy) return;
    const action = pending;
    setPending(null);
    if (blocker.state === "blocked") blocker.proceed();
    else action?.();
  };
  return {
    leave,
    prompt: (
      <dialog
        ref={dialog}
        className="edit-protection"
        aria-labelledby="edit-protection-title"
        onCancel={(event) => {
          event.preventDefault();
          stay();
        }}
      >
        <h2 id="edit-protection-title">
          {busy ? "저장 중입니다" : "편집을 끝낼까요?"}
        </h2>
        <p>
          {busy
            ? "저장이 끝날 때까지 기다려 주세요."
            : "저장하지 않은 변경 내용은 사라집니다. 진행 중인 업로드도 취소됩니다."}
        </p>
        <div className="editor-actions">
          <button type="button" className="button" autoFocus onClick={stay}>
            계속 편집
          </button>
          <button
            type="button"
            className="outline"
            disabled={busy}
            onClick={proceed}
          >
            변경 버리고 이동
          </button>
        </div>
      </dialog>
    ),
  };
}
