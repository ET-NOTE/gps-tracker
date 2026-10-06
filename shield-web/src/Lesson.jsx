import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Board, Icon } from "./components";
import { lessonLinks, lessonLines } from "./lessonContent";
function LessonText({ text }) {
  return lessonLinks(text).map((part, i) => !part.href ? part.text :
    part.href.startsWith("/") ? <Link key={i} to={part.href}>{part.text}</Link> :
      <a key={i} href={part.href} target="_blank" rel="noopener noreferrer">{part.text}</a>);
}
export function PhotoCarousel({ photos, variant }) {
  const [index, setIndex] = useState(0),
    [playing, setPlaying] = useState(
      () => !window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    ),
    [hover, setHover] = useState(false),
    [focus, setFocus] = useState(false),
    [visible, setVisible] = useState(!document.hidden);
  const touch = useRef(null),
    count = photos.length,
    active = Math.min(index, Math.max(0, count - 1));
  useEffect(() => {
    const change = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", change);
    return () => document.removeEventListener("visibilitychange", change);
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => {
      if (media.matches) setPlaying(false);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!playing || hover || focus || !visible || count < 2) return;
    const timer = setInterval(() => setIndex((i) => (i + 1) % count), 5000);
    return () => clearInterval(timer);
  }, [playing, hover, focus, visible, count, index]);
  const move = (delta) => setIndex((i) => (i + delta + count) % count);
  if (!count)
    return (
      <div className="lesson-art">
        <Board variant={variant} />
        <small>단계 사진 준비 중</small>
      </div>
    );
  const photo = photos[active];
  return (
    <section
      className="photo-carousel"
      aria-label="단계 사진"
      aria-roledescription="슬라이드"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocusCapture={() => setFocus(true)}
      onBlurCapture={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocus(false);
      }}
    >
      <figure
        onPointerDown={(e) => {
          touch.current = e.clientX;
        }}
        onPointerUp={(e) => {
          if (
            touch.current != null &&
            count > 1 &&
            Math.abs(e.clientX - touch.current) > 50
          )
            move(e.clientX > touch.current ? -1 : 1);
          touch.current = null;
        }}
      >
        <img
          src={`/api/post-images/${encodeURIComponent(photo.id)}`}
          alt={photo.alt}
          decoding="async"
          draggable={false}
        />
        {photo.caption && <figcaption>{photo.caption}</figcaption>}
      </figure>
      <a className="photo-original" href={`/api/post-images/${encodeURIComponent(photo.id)}`}
        target="_blank" rel="noopener noreferrer">이미지 크게 보기 ↗</a>
      {count > 1 && (
        <div className="carousel-controls">
          <button
            type="button"
            onClick={() => setPlaying(!playing)}
            aria-label={
              playing ? "사진 자동 넘김 일시정지" : "사진 자동 넘김 재생"
            }
          >
            {playing ? "Ⅱ 일시정지" : "▷ 자동 넘김"}
          </button>
          <button type="button" onClick={() => move(-1)} aria-label="이전 사진">
            ←
          </button>
          <span aria-live="off">
            {active + 1} / {count}
          </span>
          <button type="button" onClick={() => move(1)} aria-label="다음 사진">
            →
          </button>
        </div>
      )}
      {count > 1 && (
        <div className="carousel-dots">
          {photos.map((p, i) => (
            <button
              type="button"
              key={`${p.id}-${i}`}
              aria-label={`${i + 1}번째 사진`}
              aria-pressed={active === i}
              className={active === i ? "active" : ""}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>
      )}
    </section>
  );
}
export function DownloadList({ post, step }) {
  const files = (post.attachments || []).filter(
    (f) => f.after_step === 0 || f.after_step === step + 1,
  );
  if (!files.length && !post.code) return null;
  return (
    <section className="lesson-downloads panel">
      <div className="panel-title">
        <h2>
          <Icon name="download" />
          첨부파일 · 예제 코드
        </h2>
      </div>
      {files.length > 0 && <p className="muted">첨부파일은 Google Drive에서 열립니다. 파일을 확인한 뒤 다운로드하세요.</p>}
      <div className="download-list">
        {files.map((f, i) => (
          <a
            className="download-item"
            key={`${f.id}-${i}`}
            href={`/api/post-files/${encodeURIComponent(f.id)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon name="download" />
            <span>{f.title}</span>
            <small>Drive에서 열기 ↗</small>
          </a>
        ))}
      </div>
      {post.code && (
        <details className="code-details">
          <summary>코드 펼쳐 보기</summary>
          <pre tabIndex={0} role="region" aria-label="예제 코드">
            <code>{post.code}</code>
          </pre>
        </details>
      )}
    </section>
  );
}
export default function Lesson({ post, preview = false }) {
  const [step, setStep] = useState(0),
    card = useRef(null);
  const active = Math.min(step, post.steps.length - 1),
    titles =
      post.step_titles?.length === post.steps.length
        ? post.step_titles
        : post.steps.map((_, i) => `${i + 1}단계`);
  const photos = (post.images || []).filter((p) => p.after_step === active + 1);
  const fallback = (post.images || []).filter((p) => p.after_step === 0);
  const move = (next) => {
    setStep(next);
    if (preview) {
      card.current?.closest(".live-preview")?.scrollTo({ top: 0 });
      return;
    }
    card.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
  };
  return (
    <div className="lesson-view">
      <nav className="lesson-progress" aria-label="예제 단계">
        {post.steps.map((s, i) => (
          <button
            type="button"
            key={i}
            onClick={() => move(i)}
            aria-current={active === i ? "step" : undefined}
            className={active === i ? "active" : i < active ? "complete" : ""}
          >
            <span>{i + 1}</span>
            <strong>{titles[i]}</strong>
          </button>
        ))}
      </nav>
      <section className="panel lesson-card" ref={card}>
        <h2>
          <span className="step-number">{active + 1}</span>
          {titles[active]}
        </h2>
        <div className="lesson-columns">
          <PhotoCarousel
            key={`${post.id}-${active}`}
            photos={photos.length ? photos : fallback}
            variant={post.variant}
          />
          <div className="lesson-copy">
            <h3>
              {titles[active] == `${active + 1}단계`
                ? post.title
                : titles[active]}
            </h3>
            <ol>
              {lessonLines(post.steps[active] || "단계 내용을 입력해 주세요.")
                .map((line) => (
                  <li key={line.index} className={line.notice ? "lesson-notice" : ""}>
                    <span aria-label={line.notice ? "안내" : undefined}>{line.notice ? "!" : line.number}</span>
                    <p><LessonText text={line.text} /></p>
                  </li>
                ))}
            </ol>
            <div className="lesson-tip">
              <Icon name="check" size={18} />
              {active < post.steps.length - 1
                ? "확인이 완료되면 다음 단계로 이동하세요."
                : "모든 단계를 확인했습니다."}
            </div>
          </div>
        </div>
      </section>
      <div className="lesson-pagination">
        <button
          type="button"
          className="outline"
          disabled={active === 0}
          onClick={() => move(active - 1)}
        >
          ← 이전
        </button>
        <span>
          {active + 1} / {post.steps.length}
        </span>
        {active < post.steps.length - 1 ? (
          <button
            type="button"
            className="button"
            onClick={() => move(active + 1)}
          >
            다음: {titles[active + 1]} →
          </button>
        ) : preview ? (
          <span className="badge">마지막 단계</span>
        ) : (
          <Link className="button" to="/data">
            내 데이터 확인 →
          </Link>
        )}
      </div>
      <DownloadList post={post} step={active} />
    </div>
  );
}
