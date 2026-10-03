import React from "react";
import Lesson from "./Lesson";
import { Board } from "./components";
import { Link } from "react-router-dom";
export const imageUrl = (id) => `/api/post-images/${encodeURIComponent(id)}`;
export default function PostBody({ post }) {
  return post.kind === "project" ? (
    <ProjectBody post={post} />
  ) : (
    <Lesson post={post} preview />
  );
}

export function ProjectBody({ post }) {
  return (
    <section className="panel project-intro">
      <Board variant={post.variant} />
      <div>
        <span className="badge warm">유료 프로젝트 · 준비 중</span>
        <h2>프로젝트 공개를 준비하고 있습니다.</h2>
        <p>{post.steps.join("\n")}</p>
        <p className="muted">상품·가격·배포 일정이 확정되면 안내합니다.</p>
        <Link to="/examples/all" className="outline">
          무료 예제 먼저 보기
        </Link>
      </div>
    </section>
  );
}
