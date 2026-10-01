import React, { useEffect, useState, useRef } from "react";
import { Link } from "react-router-dom";
import { request } from "./api";
import { Intro, Icon, date } from "./components";
import { useCommerce } from "./Commerce";
const groups = [
  ["장치 연결", "chip"],
  ["USIM·포인트", "sim"],
  ["데이터", "data"],
  ["문제 해결", "signal"],
];
export default function FaqPage() {
  const [rows, setRows] = useState(null),
    [error, setError] = useState(""),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    { contact } = useCommerce();
  useEffect(() => {
    const a = new AbortController();
    request("/faqs", { signal: a.signal })
      .then(setRows)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => a.abort();
  }, []);
  const categories = [...new Set((rows || []).map((r) => r.category))],
    shown = (rows || []).filter(
      (r) =>
        (!category || r.category === category) &&
        (r.question + " " + r.answer)
          .toLowerCase()
          .includes(search.trim().toLowerCase()),
    );
  return (
    <main className="container faq-page">
      <div className="faq-heading">
        <Intro
          title="FAQ"
          description="궁금한 내용을 빠르게 확인하고, 도움이 필요하면 문의해 주세요."
        />
        <label className="search">
          <Icon name="search" />
          <input
            aria-label="FAQ 검색"
            placeholder="궁금한 내용을 검색하세요"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>
      <div className="faq-layout">
        <div>
          <div className="faq-categories">
            {categories.map((c, i) => (
              <button
                key={c}
                className={"panel " + (category === c ? "selected" : "")}
                aria-pressed={category === c}
                onClick={() => setCategory(category === c ? "" : c)}
              >
                <Icon
                  name={groups.find((g) => g[0] === c)?.[1] || groups[i % 4][1]}
                  size={28}
                />
                <strong>{c}</strong>
                <span>질문 보기 →</span>
              </button>
            ))}
          </div>
          <section className="panel faq-answers">
            <div className="panel-title">
              <h2>자주 묻는 질문</h2>
              {category && (
                <button onClick={() => setCategory("")}>전체 보기</button>
              )}
            </div>
            {error ? (
              <p className="error" role="alert">
                {error}
              </p>
            ) : rows === null ? (
              <p role="status">불러오는 중…</p>
            ) : shown.length ? (
              shown.map((r) => (
                <details key={r.id}>
                  <summary>{r.question}</summary>
                  <p>{r.answer}</p>
                </details>
              ))
            ) : (
              <p className="empty">검색 결과가 없습니다.</p>
            )}
          </section>
        </div>
        <aside className="support-cards">
          <section className="panel">
            <Icon name="user" size={32} />
            <h2>고객센터</h2>
            <p>연결부터 데이터 확인까지 도움이 필요하신가요?</p>
            <button className="button" onClick={contact}>
              1:1 채팅 문의
            </button>
            <small className="muted">상담 채널 준비 중</small>
          </section>
          <section className="panel">
            <Icon name="chip" size={32} />
            <h2>연결이 처음인가요?</h2>
            <p>쉴드 연결부터 첫 데이터 전송까지 차근차근 안내합니다.</p>
            <Link className="outline" to="/guide">
              시작가이드 보기 →
            </Link>
          </section>
          <section className="panel">
            <h2>USIM과 포인트</h2>
            <p>요금과 이용 방법을 확인하세요.</p>
            <Link className="outline" to="/pricing">
              이용 요금 안내 →
            </Link>
          </section>
        </aside>
      </div>
    </main>
  );
}
const empty = {
  id: 0,
  category: "장치 연결",
  question: "",
  answer: "",
  published: false,
  archived: false,
  position: 0,
  revision: 0,
};
export function FaqAdmin() {
  const editorRef = useRef(null);
  const [rows, setRows] = useState(null),
    [tick, setTick] = useState(0),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [search, setSearch] = useState(""),
    [category, setCategory] = useState(""),
    [state, setState] = useState("active"),
    [edit, setEdit] = useState(null),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(0);
  useEffect(() => {
    const a = new AbortController();
    request("/admin/faqs", { signal: a.signal })
      .then(setRows)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => a.abort();
  }, [tick]);
  useEffect(() => setPage(0), [search, category, state]);
  useEffect(() => {
    if (edit)
      editorRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [edit?.id]);
  async function save(v) {
    setBusy(true);
    setError("");
    try {
      const { id, updated_at, ...body } = v;
      await request("/admin/faqs/" + id, { method: "POST", body });
      setEdit(null);
      setTick((t) => t + 1);
      setNotice(
        v.archived
          ? "FAQ를 보관했습니다. 보관함에서 복원할 수 있습니다."
          : "FAQ를 저장했습니다.",
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const filtered = (rows || []).filter(
    (r) =>
      (state === "archived" ? r.archived : !r.archived) &&
      (state !== "published" || r.published) &&
      (state !== "hidden" || !r.published) &&
      (!category || r.category === category) &&
      (r.question + " " + r.answer)
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  return (
    <section className="faq-admin">
      <div className="panel-title">
        <div>
          <h2>FAQ 관리</h2>
          <p className="muted">
            질문을 공개하거나 숨기고, 수정 이력을 남깁니다.
          </p>
        </div>
        <button className="button" onClick={() => setEdit({ ...empty })}>
          + FAQ 추가
        </button>
      </div>
      <div className="admin-toolbar">
        <button
          className="outline"
          onClick={() => {
            setError("");
            setTick((t) => t + 1);
          }}
        >
          새로고침
        </button>
        <select
          aria-label="FAQ 분류"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="">전체 카테고리</option>
          {[...new Set((rows || []).map((r) => r.category))].map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <select
          aria-label="FAQ 노출 상태"
          value={state}
          onChange={(e) => setState(e.target.value)}
        >
          <option value="active">노출 상태 전체</option>
          <option value="published">노출</option>
          <option value="hidden">숨김</option>
          <option value="archived">보관함</option>
        </select>
        <input
          aria-label="관리자 FAQ 검색"
          placeholder="제목 또는 내용을 검색하세요"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <div className="panel table-scroll">
        <table>
          <thead>
            <tr>
              {[
                "번호",
                "카테고리",
                "질문 제목",
                "노출 상태",
                "수정일",
                "관리",
              ].map((x) => (
                <th key={x}>{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.slice(page * 10, page * 10 + 10).map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.category}</td>
                <td>{r.question}</td>
                <td>
                  <span className={"badge " + (r.published ? "" : "neutral")}>
                    {r.archived ? "보관" : r.published ? "노출" : "숨김"}
                  </span>
                </td>
                <td>{date(r.updated_at)}</td>
                <td>
                  <button disabled={busy} onClick={() => setEdit({ ...r })}>
                    수정
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      save({ ...r, archived: !r.archived, published: false })
                    }
                  >
                    {r.archived ? "숨김으로 복원" : "보관"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows === null ? (
          <p role="status">불러오는 중…</p>
        ) : (
          !filtered.length && <p className="empty">해당 FAQ가 없습니다.</p>
        )}
      </div>
      <div className="pagination">
        <span>총 {filtered.length}개</span>
        <button disabled={!page} onClick={() => setPage((p) => p - 1)}>
          이전
        </button>
        <span>{page + 1}</span>
        <button
          disabled={(page + 1) * 10 >= filtered.length}
          onClick={() => setPage((p) => p + 1)}
        >
          다음
        </button>
      </div>
      {edit && (
        <div className="panel faq-edit" ref={editorRef}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              save(edit);
            }}
          >
            <h2>{edit.id ? "FAQ 편집" : "새 FAQ"}</h2>
            <fieldset disabled={busy}>
              {[
                ["category", "분류", 40],
                ["question", "질문", 200],
              ].map(([k, l, max]) => (
                <label key={k}>
                  {l}
                  <input
                    required
                    maxLength={max}
                    value={edit[k]}
                    onChange={(e) => setEdit({ ...edit, [k]: e.target.value })}
                  />
                </label>
              ))}
              <label>
                답변
                <textarea
                  rows={7}
                  maxLength={4000}
                  required
                  value={edit.answer}
                  onChange={(e) => setEdit({ ...edit, answer: e.target.value })}
                />
              </label>
              <label>
                표시 순서 (작을수록 먼저)
                <input
                  type="number"
                  min="0"
                  max="10000"
                  value={edit.position}
                  onChange={(e) =>
                    setEdit({ ...edit, position: Number(e.target.value) })
                  }
                />
              </label>
              <label className="check-line">
                <input
                  type="checkbox"
                  disabled={edit.archived}
                  checked={edit.published}
                  onChange={(e) =>
                    setEdit({ ...edit, published: e.target.checked })
                  }
                />
                공개 페이지에 노출
              </label>
              <div className="editor-actions">
                <button className="button">저장</button>
                <button type="button" onClick={() => setEdit(null)}>
                  편집 닫기
                </button>
              </div>
            </fieldset>
          </form>
          <aside className="post-preview">
            <span className="badge">사용자 미리보기</span>
            <details open>
              <summary>{edit.question || "질문"}</summary>
              <p style={{ whiteSpace: "pre-wrap" }}>
                {edit.answer || "답변을 입력하세요."}
              </p>
            </details>
          </aside>
        </div>
      )}
    </section>
  );
}
