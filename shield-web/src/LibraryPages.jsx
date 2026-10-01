import { ProjectBody } from "./PostBody";
import React, { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Board, Icon, Intro } from "./components";
import { usePosts, PostStatus } from "./posts";
import Lesson from "./Lesson";
const kindOf = (p) => p.kind || "example";
export function ExampleCard({ post, compact = false }) {
  const project = kindOf(post) === "project";
  const icon =
    post.category === "GPS"
      ? "pin"
      : post.variant === "data"
        ? "data"
        : post.variant === "sensor"
          ? "signal"
          : "code";
  return (
    <Link
      className={`catalog-card ${project ? "project-card" : ""} ${compact ? "compact-card" : ""}`}
      to={"/examples/" + post.id}
    >
      <div className="catalog-art">
        {project ? (
          <Board variant={post.variant} small />
        ) : (
          <Icon name={icon} size={40} />
        )}
        <span className={"badge " + (project ? "warm" : "")}>
          {project ? "준비 중" : "무료"}
        </span>
      </div>
      <div className="catalog-copy">
        <h3>{post.title}</h3>
        {!compact && <p>{post.description}</p>}
        <div className="tags">
          <span>{post.category}</span>
          {!compact && (
            <span>
              {post.level} · {post.minutes}분
            </span>
          )}
        </div>
        <strong>
          {project ? "프로젝트 소개" : "예제 보기"}{" "}
          <Icon name="arrow" size={15} />
        </strong>
      </div>
    </Link>
  );
}
function PlannedProjects() {
  return (
    <div className="catalog-grid planned-projects">
      {[
        [
          "pin",
          "위치 추적 프로젝트",
          "현재 위치와 이동 경로를 활용하는 프로젝트",
        ],
        [
          "chip",
          "다중 장치 관리",
          "여러 쉴드의 데이터를 함께 살펴보는 프로젝트",
        ],
        [
          "signal",
          "센서 모니터링",
          "다양한 센서 데이터를 기록하고 활용하는 프로젝트",
        ],
      ].map(([icon, title, text]) => (
        <article className="catalog-card project-card" key={title}>
          <div className="planned-art">
            <Icon name={icon} size={48} />
            <span className="badge warm">준비 중</span>
          </div>
          <div className="catalog-copy">
            <h3>{title}</h3>
            <p>{text}</p>
            <small>상품·가격·배포 일정 준비 중</small>
          </div>
        </article>
      ))}
    </div>
  );
}
function GuideBanner() {
  return (
    <Link to="/guide" className="guide-banner slim-guide">
      <Icon name="book" size={40} />
      <div>
        <small>처음 사용하시나요?</small>
        <h2>시작 가이드부터 따라해 보세요.</h2>
      </div>
      <span className="button">시작 가이드 보기 →</span>
    </Link>
  );
}
export function Library() {
  const { posts, loading, error } = usePosts(),
    examples = posts.filter((p) => kindOf(p) === "example"),
    projects = posts.filter((p) => kindOf(p) === "project");
  return (
    <main className="container library-page">
      <div className="library-heading">
        <Intro
          title="예제 라이브러리"
          description="필요한 예제만, 바로 시작하세요."
        />
        <Board small />
      </div>
      <PostStatus />
      <section className="library-section">
        <div className="section-heading">
          <h2>
            기본 예제 <span className="badge">무료</span>
          </h2>
          <Link to="/examples/all">전체 보기 →</Link>
        </div>
        <div className="catalog-grid">
          {examples.slice(0, 6).map((p) => (
            <ExampleCard key={p.id} post={p} compact />
          ))}
        </div>
        {!loading && !error && !examples.length && (
          <p className="empty">기본 예제를 준비하고 있습니다.</p>
        )}
      </section>
      <section className="library-section">
        <div className="section-heading">
          <h2>
            응용 프로젝트 <span className="badge warm">유료 · 준비 중</span>
          </h2>
          <Link to="/projects">전체 보기 →</Link>
        </div>
        {projects.length ? (
          <div className="catalog-grid">
            {projects.slice(0, 3).map((p) => (
              <ExampleCard key={p.id} post={p} />
            ))}
          </div>
        ) : !loading && !error ? (
          <PlannedProjects />
        ) : null}
      </section>
      <GuideBanner />
    </main>
  );
}
export function Catalog({ kind }) {
  const { posts, loading, error } = usePosts(),
    [category, setCategory] = useState("전체"),
    [search, setSearch] = useState("");
  const available = posts.filter((p) => kindOf(p) === kind),
    categories = ["전체", ...new Set(available.map((p) => p.category))];
  const shown = available.filter(
    (p) =>
      (category === "전체" || p.category === category) &&
      (p.title + " " + p.description)
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  return (
    <main className="container catalog-page">
      <Intro
        crumb="예제 라이브러리"
        title={kind === "project" ? "응용 프로젝트" : "기본 예제"}
        description={
          kind === "project"
            ? "쉴드를 활용한 프로젝트를 준비하고 있습니다."
            : "무료 예제를 한곳에서 바로 시작하세요."
        }
      />
      {(kind !== "project" || available.length > 0) && (
        <div className="catalog-filters">
          <div className="tabs" aria-label="예제 카테고리">
            {categories.map((c) => (
              <button
                key={c}
                aria-pressed={category === c}
                className={category === c ? "active" : ""}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
          <label className="search">
            <Icon name="search" size={18} />
            <input
              aria-label="예제 검색"
              placeholder="예제 검색"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
        </div>
      )}
      <PostStatus />
      <p className="muted">
        {kind === "project" && !available.length
          ? "프로젝트 공개 준비 중"
          : `${shown.length}개 ${kind === "project" ? "프로젝트" : "예제"}`}
      </p>
      <div className="catalog-grid full-catalog">
        {shown.map((p) => (
          <ExampleCard key={p.id} post={p} />
        ))}
      </div>
      {kind === "project" && !available.length && !loading && !error ? (
        <PlannedProjects />
      ) : !shown.length && !loading && !error ? (
        <div className="panel empty">
          검색 결과가 없습니다. 다른 검색어나 카테고리를 선택해 주세요.
        </div>
      ) : null}
      <Link className="text-link" to="/examples">
        ← 예제 라이브러리
      </Link>
    </main>
  );
}
export function LessonPage({ guide = false }) {
  const { id } = useParams(),
    { posts, settings, loading, error } = usePosts(),
    slug = guide ? settings.guide_slug : id,
    post = posts.find((p) => p.id === slug);
  if (loading || error)
    return (
      <main className="container">
        <PostStatus />
      </main>
    );
  if (!post)
    return (
      <main className="container empty">
        <h1>공개된 예제를 찾을 수 없습니다.</h1>
        <Link className="button" to="/examples">
          예제 라이브러리
        </Link>
      </main>
    );
  if (kindOf(post) === "project")
    return (
      <main className="container">
        <Intro
          crumb="응용 프로젝트"
          title={post.title}
          description={post.description}
        />
        <ProjectBody post={post} />
      </main>
    );
  return (
    <main className="container lesson-page">
      <Intro
        crumb={guide ? "시작가이드" : "예제 라이브러리"}
        title={guide ? `${post.steps.length}단계로 시작하세요` : post.title}
        description={post.description}
      />
      <Lesson post={post} key={post.id} />
      <div className="lesson-related">
        <Link to="/examples/all">← 전체 예제</Link>
        {guide && (
          <Link to={"/examples/" + post.id}>예제 라이브러리에서 보기 →</Link>
        )}
      </div>
    </main>
  );
}
export function GuidePage() {
  return <LessonPage guide />;
}
