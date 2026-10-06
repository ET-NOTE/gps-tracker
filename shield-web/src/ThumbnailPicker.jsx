import React, { useEffect, useRef, useState } from "react";
import { uploadPostImage } from "./postImages";

export default function ThumbnailPicker({ value, onChange, onBusy, disabled = false, label = "썸네일" }) {
  const picker = useRef(null), task = useRef(null);
  const [uploading, setUploading] = useState(false), [error, setError] = useState("");
  useEffect(() => () => { task.current?.abort(); onBusy(false); }, [onBusy]);
  async function upload(files) {
    if (disabled || task.current || !files?.length) return;
    if (files.length !== 1) { setError("썸네일은 한 장만 선택해 주세요."); return; }
    const controller = new AbortController(); task.current = controller;
    setUploading(true); onBusy(true); setError("");
    try {
      const image = await uploadPostImage(files[0], controller.signal);
      controller.signal.throwIfAborted();
      onChange({ id: image.id, alt: value?.alt || label });
    } catch (e) { if (e.name !== "AbortError") setError(e.message); }
    finally {
      if (!controller.signal.aborted) { task.current = null; setUploading(false); onBusy(false); }
    }
  }
  return <section className="thumbnail-picker" aria-label={`${label} 업로드`} tabIndex={0}
    onPaste={(e) => {
      const files = Array.from(e.clipboardData?.items || []).filter(x => x.kind === "file").map(x => x.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); e.stopPropagation(); upload(files); }
    }}
    onDragOver={(e) => { if (Array.from(e.dataTransfer.types).includes("Files")) e.preventDefault(); }}
    onDrop={(e) => { if (Array.from(e.dataTransfer.types).includes("Files")) { e.preventDefault(); e.stopPropagation(); upload(e.dataTransfer.files); } }}>
    <h3>{label}</h3>
    <p className="muted">사진을 선택하거나 이 영역에 Ctrl+V로 붙여넣으세요. PNG·JPEG·WebP, 원본 10MB 이하. 전체 이미지가 잘리지 않게 표시됩니다.</p>
    {value && <img className="thumbnail-picker-image" src={`/api/post-images/${value.id}`} alt={value.alt} />}
    <div className="editor-actions">
      <button type="button" className="outline" disabled={disabled || uploading} onClick={() => picker.current.click()}>
        {uploading ? "올리는 중…" : value ? "썸네일 교체" : "썸네일 파일 선택"}
      </button>
      {value && <button type="button" disabled={disabled || uploading} onClick={() => onChange(null)}>썸네일 삭제</button>}
      <input hidden type="file" ref={picker} accept="image/png,image/jpeg,image/webp" onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
    </div>
    {value && <label>썸네일 설명 (접근성)<input required maxLength={200} disabled={disabled || uploading} value={value.alt}
      onChange={e => onChange({ ...value, alt: e.target.value })} /></label>}
    <p className="muted">저장하면 반영됩니다. 썸네일을 삭제하면 기존 기본 그림으로 표시됩니다.</p>
    {error && <p className="error" role="alert">{error}</p>}
  </section>;
}
