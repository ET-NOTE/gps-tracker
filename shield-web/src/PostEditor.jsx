import AttachmentEditor from "./AttachmentEditor";
import React, { useEffect, useRef, useState } from "react";
import PostBody, { imageUrl } from "./PostBody";
import { uploadPostImage, moveStep, removeStep } from "./postImages";

export default function PostEditor({
  edit,
  setEdit,
  busy,
  saveError,
  onSave,
  onClose,
}) {
  const root = useRef(null),
    picker = useRef(null),
    task = useRef(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [position, setPosition] = useState(edit.content.steps.length);
  const [uploading, setUploading] = useState(false),
    [progress, setProgress] = useState("");
  const [error, setError] = useState(""),
    [preview, setPreview] = useState(false);
  const content = edit.content,
    photos = content.images || [];
  useEffect(() => {
    root.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    return () => task.current?.abort();
  }, []);
  const change = (key, value) =>
    setEdit((v) => ({ ...v, content: { ...v.content, [key]: value } }));
  const changeContent = (fn) =>
    setEdit((v) => ({ ...v, content: fn(v.content) }));
  function editPhoto(index, patch) {
    change(
      "images",
      photos.map((x, i) => (i === index ? { ...x, ...patch } : x)),
    );
  }
  async function addPhotos(files, at = position) {
    if (task.current || busy || fileBusy) return;
    const items = Array.from(files);
    if (!items.length) return;
    if (items.length + photos.length > 20) {
      setError("게시물당 사진을 최대 20장 넣을 수 있습니다.");
      return;
    }
    const controller = new AbortController();
    task.current = controller;
    setUploading(true);
    setError("");
    try {
      for (let i = 0; i < items.length; i++) {
        setProgress(`사진 ${i + 1}/${items.length} 처리 중…`);
        const image = await uploadPostImage(items[i], controller.signal);
        controller.signal.throwIfAborted();
        setEdit((v) => ({
          ...v,
          content: {
            ...v.content,
            images: [
              ...(v.content.images || []),
              {
                id: image.id,
                after_step: Math.min(at, v.content.steps.length),
                alt: "단계 안내 사진",
                caption: "",
              },
            ],
          },
        }));
      }
      setProgress(
        "사진을 추가했습니다. 설명을 입력하고 게시물을 저장해 주세요.",
      );
    } catch (e) {
      if (e.name !== "AbortError") setError(e.message);
    } finally {
      if (!controller.signal.aborted) {
        task.current = null;
        setUploading(false);
      }
    }
  }
  function paste(e) {
    const files = Array.from(e.clipboardData?.items || [])
      .filter((x) => x.kind === "file")
      .map((x) => x.getAsFile())
      .filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addPhotos(files);
    }
  }
  function drop(e) {
    if (Array.from(e.dataTransfer.types).includes("Files")) {
      e.preventDefault();
      const at = e.target.closest("[data-photo-position]")?.dataset
        .photoPosition;
      addPhotos(e.dataTransfer.files, at == null ? position : Number(at));
    }
  }
  function imagesAt(at) {
    const group = photos
      .map((photo, index) => ({ photo, index }))
      .filter(({ photo }) => photo.after_step === at);
    return group.map(({ photo, index }, order) => (
      <div
        className="photo-edit"
        data-photo-position={at}
        key={`${photo.id}-${index}`}
      >
        <img src={imageUrl(photo.id)} alt={photo.alt} />
        <div className="photo-fields">
          <label>
            사진 설명 (접근성)
            <input
              required
              maxLength={200}
              value={photo.alt}
              onChange={(e) => editPhoto(index, { alt: e.target.value })}
            />
          </label>
          <label>
            사진 아래 표시할 설명
            <input
              maxLength={500}
              value={photo.caption}
              onChange={(e) => editPhoto(index, { caption: e.target.value })}
            />
          </label>
          <label>
            사진 위치
            <select
              value={photo.after_step}
              onChange={(e) =>
                editPhoto(index, { after_step: Number(e.target.value) })
              }
            >
              {positions()}
            </select>
          </label>
          <div className="editor-actions">
            {[-1, 1].map((direction) => (
              <button
                type="button"
                key={direction}
                disabled={!group[order + direction]}
                aria-label={`사진 ${index + 1} ${direction < 0 ? "위로" : "아래로"}`}
                onClick={() => {
                  const next = [...photos],
                    other = group[order + direction].index;
                  [next[index], next[other]] = [next[other], next[index]];
                  change("images", next);
                }}
              >
                {direction < 0 ? "↑ 위로" : "↓ 아래로"}
              </button>
            ))}
            <button
              type="button"
              onClick={() =>
                change(
                  "images",
                  photos.filter((_, i) => i !== index),
                )
              }
            >
              사진 빼기
            </button>
          </div>
        </div>
      </div>
    ));
  }
  function positions() {
    return Array.from({ length: content.steps.length + 1 }, (_, i) => (
      <option key={i} value={i}>
        {i === 0 ? "첫 단계 앞" : `${i}단계 뒤`}
      </option>
    ));
  }
  return (
    <section className="panel editor post-editor" ref={root}>
      <div className="panel-title">
        <h2>{edit.revision ? "게시물 편집" : "새 게시물"}</h2>
        <button
          type="button"
          onClick={() => setPreview(!preview)}
          aria-pressed={preview}
        >
          {preview ? "미리보기 닫기" : "미리보기"}
        </button>
      </div>
      <p className="muted">
        사진과 글을 수정한 뒤 아래 저장 버튼을 눌러 주세요. 저장 전에는 공개
        페이지가 바뀌지 않습니다.
      </p>
      {(error || saveError) && (
        <p className="error" role="alert">
          {error || saveError}
        </p>
      )}
      {progress && (
        <p className="notice" role="status">
          {progress}
        </p>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!uploading && !fileBusy && !busy) onSave();
        }}
      >
        <fieldset disabled={busy || uploading || fileBusy}>
          <label>
            콘텐츠 종류
            <select
              value={content.kind || "example"}
              onChange={(e) => change("kind", e.target.value)}
            >
              <option value="example">기본 예제 · 무료</option>
              <option
                value="project"
                disabled={!!content.code || !!content.attachments?.length}
              >
                응용 프로젝트 · 준비 중
              </option>
            </select>
          </label>
          {content.kind === "project" && (
            <p className="notice">
              응용 프로젝트는 소개용으로 표시됩니다. 판매 준비 전 유료 코드·배포
              파일은 등록할 수 없습니다.
            </p>
          )}
          <div className="form-grid">
            {[
              ["id", "주소 슬러그"],
              ["title", "제목"],
              ["description", "요약"],
              ["category", "분류"],
            ].map(([key, label]) => (
              <label key={key}>
                {label}
                <input
                  required
                  value={content[key]}
                  disabled={key === "id" && edit.revision > 0}
                  maxLength={
                    { id: 64, title: 120, description: 500, category: 40 }[key]
                  }
                  pattern={key === "id" ? "[a-z0-9-]+" : undefined}
                  onChange={(e) => change(key, e.target.value)}
                />
              </label>
            ))}
            <label>
              난이도
              <select
                value={content.level}
                onChange={(e) => change("level", e.target.value)}
              >
                {["입문", "기초", "응용"].map((x) => (
                  <option key={x}>{x}</option>
                ))}
              </select>
            </label>
            <label>
              소요 시간 (분)
              <input
                type="number"
                required
                min="1"
                max="600"
                value={content.minutes}
                onChange={(e) => change("minutes", Number(e.target.value))}
              />
            </label>
            <label>
              목록 대표 그림
              <select
                value={content.variant}
                onChange={(e) => change("variant", e.target.value)}
              >
                <option value="board">쉴드</option>
                <option value="sensor">센서</option>
                <option value="data">데이터</option>
              </select>
            </label>
          </div>
          <div
            className="post-compose"
            onPaste={paste}
            onDrop={drop}
            onDragOver={(e) => {
              if (Array.from(e.dataTransfer.types).includes("Files"))
                e.preventDefault();
            }}
          >
            <h3>본문과 사진</h3>
            <div
              className="photo-drop"
              tabIndex={0}
              aria-label="사진 붙여넣기 영역"
            >
              <strong>
                사진을 복사한 뒤 Ctrl+V로 붙여넣거나 여기로 끌어 놓으세요.
              </strong>
              <p>
                PNG·JPEG·WebP, 원본 10MB 이하 · 최대 20장 · 큰 사진은 자동
                축소합니다.
              </p>
              <div className="editor-actions">
                <label>
                  추가 위치
                  <select
                    value={position}
                    onChange={(e) => setPosition(Number(e.target.value))}
                  >
                    {positions()}
                  </select>
                </label>
                <button
                  className="outline"
                  type="button"
                  onClick={() => picker.current.click()}
                >
                  사진 파일 선택
                </button>
                <input
                  ref={picker}
                  type="file"
                  hidden
                  multiple
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(e) => {
                    addPhotos(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>
            </div>
            {imagesAt(0)}
            {content.steps.map((step, i) => (
              <div
                className="step-edit"
                data-photo-position={i + 1}
                key={i}
                onFocusCapture={() => setPosition(i + 1)}
              >
                <div className="panel-title">
                  <strong>{i + 1}단계</strong>
                  <div className="editor-actions">
                    {[-1, 1].map((d) => (
                      <button
                        type="button"
                        key={d}
                        disabled={i + d < 0 || i + d >= content.steps.length}
                        aria-label={`${i + 1}단계 ${d < 0 ? "위로" : "아래로"}`}
                        onClick={() => {
                          changeContent((c) => moveStep(c, i, i + d));
                          setPosition(i + d + 1);
                        }}
                      >
                        {d < 0 ? "↑" : "↓"}
                      </button>
                    ))}
                    <button
                      type="button"
                      disabled={content.steps.length === 1}
                      onClick={() => {
                        changeContent((c) => removeStep(c, i));
                        setPosition(
                          Math.min(position, content.steps.length - 1),
                        );
                      }}
                    >
                      단계 빼기
                    </button>
                  </div>
                </div>
                <label>
                  {i + 1}단계 제목
                  <input
                    required
                    maxLength={80}
                    value={content.step_titles?.[i] ?? `${i + 1}단계`}
                    onChange={(e) =>
                      change(
                        "step_titles",
                        content.steps.map((_, j) =>
                          j === i
                            ? e.target.value
                            : content.step_titles?.[j] || `${j + 1}단계`,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  {i + 1}단계 내용
                  <textarea
                    required
                    rows={3}
                    maxLength={2000}
                    value={step}
                    onChange={(e) =>
                      change(
                        "steps",
                        content.steps.map((s, j) =>
                          i === j ? e.target.value : s,
                        ),
                      )
                    }
                  />
                </label>
                {imagesAt(i + 1)}
                <button
                  className="outline"
                  type="button"
                  onClick={() => {
                    setPosition(i + 1);
                    picker.current.click();
                  }}
                >
                  {i + 1}단계 뒤에 사진 넣기
                </button>
              </div>
            ))}
            <button
              type="button"
              disabled={content.steps.length >= 50}
              onClick={() =>
                changeContent((c) => ({
                  ...c,
                  steps: [...c.steps, ""],
                  step_titles: [
                    ...c.steps.map(
                      (_, i) => c.step_titles?.[i] || `${i + 1}단계`,
                    ),
                    `${c.steps.length + 1}단계`,
                  ],
                }))
              }
            >
              + 단계 추가
            </button>
          </div>
          {content.kind !== "project" && (
            <AttachmentEditor
              content={content}
              change={change}
              onBusy={setFileBusy}
            />
          )}
          <label>
            예제 코드
            <textarea
              rows={10}
              disabled={content.kind === "project"}
              className="code-editor"
              maxLength={16000}
              value={content.code || ""}
              onChange={(e) => change("code", e.target.value)}
            />
          </label>
          <label className="check-line">
            <input
              type="checkbox"
              checked={edit.published}
              onChange={(e) =>
                setEdit({ ...edit, published: e.target.checked })
              }
            />
            공개 페이지에 게시
          </label>
          <button className="button">저장</button>
        </fieldset>
      </form>
      <button type="button" disabled={busy} onClick={onClose}>
        {uploading || fileBusy ? "업로드 취소하고 편집 닫기" : "편집 닫기"}
      </button>
      {preview && (
        <section
          className="post-preview"
          aria-label="게시물 미리보기"
        >
          <span className="badge">저장 전 미리보기</span>
          <h2>{content.title || "제목"}</h2>
          <p>{content.description}</p>
          <PostBody post={content} />
        </section>
      )}
    </section>
  );
}
