import { ProjectBody } from "./PostBody";
import React from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { Board, Icon, Intro } from "./components";
import { usePosts, PostStatus } from "./posts";
import Lesson from "./Lesson";
import { lessonReplacement, visibleLessons, featuredLessons } from "./lessonContent";
const kindOf = (p) => p.kind || "example";
const categoryOf = (p) => p.category?.trim() || "기타";
const categoryDetails = new Map([
  ["시작하기", ["code", "쉴드 연결과 개발 환경 설정부터 첫 데이터 전송까지 시작해 보세요."]],
  ["센서·데이터활용", ["data", "센서 측정, GPS 위치 확인과 수집한 데이터 활용을 함께 배워보세요."]],
  ["외부서버연동", ["server", "데이터베이스와 외부 서비스를 연결해 프로젝트를 확장해 보세요."]],
  ["데이터 연동", ["database", "다양한 데이터 소스와 서비스를 연결하는 방법을 알아보세요."]],
  ["센서", ["data", "온도, 습도 등 센서에서 측정한 데이터를 다뤄보세요."]],
  ["GPS", ["pin", "현재 위치를 확인하고 GPS 데이터를 활용해 보세요."]],
  ["서버 연동", ["server", "API 호출과 데이터 전송으로 서버와 통신하는 방법을 배워보세요."]],
  ["Firebase", ["database", "Firebase에 데이터를 저장하고 활용하는 방법을 알아보세요."]],
  ["아두이노 기초(공용)", ["chip", "아두이노와 친숙해지고 배선, 컴파일, 업로드의 기본을 익혀보세요."]],
  ["기타", ["book", "쉴드를 활용하는 다양한 예제를 확인해 보세요."]],
]);
const categoryHref = (category) => "/examples/all?" + new URLSearchParams({ category });
export function categoryGroups(examples) {
  const counts = new Map();
  for (const post of examples) {
    const category = categoryOf(post);
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  const names = [...categoryDetails.keys()].filter((name) => counts.has(name));
  names.push(...[...counts.keys()].filter((name) => !categoryDetails.has(name)).sort((a, b) => a.localeCompare(b, "ko")));
  return names.map((name) => ({ name, count: counts.get(name),
    icon: categoryDetails.get(name)?.[0] || "book",
    description: categoryDetails.get(name)?.[1] || `${name} 관련 예제를 모았습니다. 필요한 예제를 선택해 시작하세요.`,
  }));
}
export function CategoryCard({ category, thumbnail, preview = false }) {
  const Tag = preview ? "article" : Link;
  return <Tag className="category-card" {...(!preview && { to: categoryHref(category.name) })}>
    <div className={"category-card-top " + (thumbnail ? "has-thumbnail" : "")}>
      {thumbnail ? <img className="category-cover" src={`/api/post-images/${thumbnail.id}`} alt={thumbnail.alt} loading="lazy" />
        : <span className="category-icon"><Icon name={category.icon} size={36} /></span>}
      <span className="badge">{category.count}개 예제</span>
    </div>
    <h3>{category.name}</h3>
    <div className="category-card-copy"><p>{category.description}</p><Icon name="arrow" size={20} /></div>
  </Tag>;
}
export function ExampleCard({ post, preview = false }) {
  const project = kindOf(post) === "project";
  const Tag = preview ? "article" : Link;
  const icon =
    post.category === "GPS"
      ? "pin"
      : post.variant === "data"
        ? "data"
        : post.variant === "sensor"
          ? "signal"
          : "code";
  return (
    <Tag
      className={`catalog-card ${project ? "project-card" : ""}`}
      {...(!preview && { to: "/examples/" + post.id })}
    >
      <div className={"catalog-art " + (post.thumbnail ? "has-thumbnail" : "")}>
        {post.thumbnail ? <img className="catalog-cover" src={`/api/post-images/${post.thumbnail.id}`} alt={post.thumbnail.alt} loading="lazy" /> : project ? (
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
        <p>{post.description}</p>
        <div className="tags">
          <span>{post.category}</span>
          <span>{post.level} · {post.minutes}분</span>
        </div>
        <strong>
          {project ? "프로젝트 소개" : "예제 보기"}{" "}
          <Icon name="arrow" size={15} />
        </strong>
      </div>
    </Tag>
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
  const { posts, settings, categoryThumbnails, loading, error } = usePosts(),
    examples = featuredLessons(posts, settings.guide_slug),
    projects = posts.filter((p) => kindOf(p) === "project");
  const [params, setParams] = useSearchParams(),
    search = params.get("q") || "",
    categories = categoryGroups(examples),
    shown = categories.filter((c) => (c.name + " " + c.description).toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <main className="container library-page">
      <div className="category-heading">
        <Intro
          title="예제 라이브러리"
          description="카테고리를 선택하고, 필요한 예제부터 시작하세요."
        >
          <label className="search">
            <Icon name="search" size={20} />
            <input aria-label="카테고리 검색" placeholder="카테고리 검색" value={search}
              onChange={(e) => setParams((previous) => {
                const next = new URLSearchParams(previous);
                if (e.target.value) next.set("q", e.target.value); else next.delete("q");
                return next;
              }, { replace: true })} />
          </label>
        </Intro>
      </div>
      <PostStatus />
      <section className="library-section">
        <div className="section-heading">
          <h2>
            기본 예제 <span className="badge">무료</span>
          </h2>
          <Link to="/examples/all">모든 예제 보기 →</Link>
        </div>
        <nav className="category-grid" aria-label="기본 예제 카테고리">
          {shown.map((category) => (
            <CategoryCard key={category.name} category={category}
              thumbnail={categoryThumbnails.find(t => t.category === category.name)?.thumbnail} />
          ))}
        </nav>
        {!loading && !error && !examples.length && (
          <p className="empty">기본 예제를 준비하고 있습니다.</p>
        )}
        {!loading && !error && examples.length > 0 && !shown.length && (
          <div className="panel empty"><p>검색한 카테고리가 없습니다. 다른 검색어를 입력해 주세요.</p>
            <button className="outline" onClick={() => setParams({}, { replace: true })}>검색 초기화</button>
          </div>
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
  const { posts, settings, loading, error } = usePosts(),
    [params, setParams] = useSearchParams(),
    category = params.get("category") || "",
    search = params.get("q") || "";
  const available = kind === "example" ? featuredLessons(posts, settings.guide_slug)
      : visibleLessons(posts).filter((p) => kindOf(p) === kind),
    categories = ["", ...categoryGroups(available).map((c) => c.name)];
  function filter(key, value, replace = false) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value); else next.delete(key);
      return next;
    }, { replace });
  }
  const shown = available.filter(
    (p) =>
      (!category || categoryOf(p) === category) &&
      (p.title + " " + p.description)
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  return (
    <main className="container catalog-page">
      <Intro
        crumb={<Link to="/examples">예제 라이브러리</Link>}
        title={kind === "project" ? "응용 프로젝트" : category ? `${category} 예제` : "전체 기본 예제"}
        description={
          kind === "project"
            ? "쉴드를 활용한 프로젝트를 준비하고 있습니다."
            : categoryDetails.get(category)?.[1] || "무료 예제를 한곳에서 바로 시작하세요."
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
                onClick={() => filter("category", c)}
              >
                {c || "전체"}
              </button>
            ))}
          </div>
          <label className="search">
            <Icon name="search" size={18} />
            <input
              aria-label="예제 검색"
              placeholder="예제 검색"
              value={search}
              onChange={(e) => filter("q", e.target.value, true)}
            />
          </label>
        </div>
      )}
      <PostStatus />
      {!loading && !error && <p className="muted" role="status">
        {kind === "project" && !available.length
          ? "프로젝트 공개 준비 중"
          : `${shown.length}개 ${kind === "project" ? "프로젝트" : "예제"}`}
      </p>}
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
          <Link className="text-link" to={kind === "project" ? "/projects" : "/examples/all"}>필터 초기화 →</Link>
        </div>
      ) : null}
      <Link className="text-link" to="/examples">
        ← 예제 카테고리 보기
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
  const replacement = !guide && lessonReplacement(id, posts);
  if (replacement) return <Navigate to={`/examples/${replacement}`} replace />;
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
        breadcrumb={!guide}
        title={post.title}
        description={post.description}
      />
      <Lesson post={post} key={post.id} />
      {!guide && <div className="lesson-related">
        <Link to={categoryHref(categoryOf(post))}>← {categoryOf(post)} 예제</Link>
      </div>}
    </main>
  );
}
export function GuidePage() {
  return <LessonPage guide />;
}
