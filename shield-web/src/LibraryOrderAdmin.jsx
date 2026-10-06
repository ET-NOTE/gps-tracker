import React, { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { usePosts } from "./posts";
import { categoryGroups } from "./LibraryPages";
import { featuredLessons } from "./lessonContent";
import { categoryName, moveItem, sortByOrder } from "./libraryOrder";

function Position({ label, index, count, disabled, onMove }) {
  return <div className="order-controls">
    <select aria-label={`${label} 순서`} value={index} disabled={disabled} onChange={e => onMove(Number(e.target.value))}>
      {Array.from({ length: count }, (_, i) => <option key={i} value={i}>{i + 1}번째</option>)}
    </select>
    <button type="button" className="outline" aria-label={`${label} 위로`} disabled={disabled || index === 0} onClick={() => onMove(index - 1)}>↑</button>
    <button type="button" className="outline" aria-label={`${label} 아래로`} disabled={disabled || index === count - 1} onClick={() => onMove(index + 1)}>↓</button>
  </div>;
}

export default function LibraryOrderAdmin({ requestLeave, onStatus }) {
  const { reload } = usePosts();
  const [edit, setEdit] = useState(null), [examples, setExamples] = useState([]), [selected, setSelected] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [tick, setTick] = useState(0);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const initial = useRef("");
  const dirty = !!edit && JSON.stringify(edit) !== initial.current;
  useEffect(() => { onStatus({ dirty, busy }); }, [dirty, busy, onStatus]);
  useEffect(() => () => onStatus({ dirty: false, busy: false }), [onStatus]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError(""); setNotice("");
    Promise.all(["/admin/library-order", "/posts", "/site-settings"].map(path => request(path, { signal: abort.signal }))).then(([order, posts, settings]) => {
      const current = featuredLessons(posts, settings.guide_slug);
      const categories = categoryGroups(current, order.categories).map(g => g.name);
      const next = { categories, lessons: Object.fromEntries(categories.map(name => [name,
        sortByOrder(current.filter(p => categoryName(p) === name), order.lessons[name]).map(p => p.id)])), revision: order.revision };
      initial.current = JSON.stringify(next); setEdit(next); setExamples(current);
      setSelected(previous => categories.includes(previous) ? previous : categories[0] || "");
    }).catch(e => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [tick]);
  async function save() {
    if (loading || busy || !dirty) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await request("/admin/library-order", { method: "POST", body: edit });
      initial.current = JSON.stringify(next); setEdit(next); await reload();
      setNotice("카테고리와 강의 노출 순서를 저장했습니다.");
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const lessons = edit?.lessons[selected] || [];
  return <section className="library-order-admin">
    <div className="section-heading"><div><h2>카테고리·강의 노출 순서</h2><p>화살표 또는 순서 선택으로 옮긴 뒤 저장하세요. 왼쪽 카테고리를 선택하면 안에 있는 강의 순서를 바꿀 수 있습니다.</p></div>
      <div className="editor-actions"><button className="outline" disabled={busy || loading} onClick={() => requestLeave(() => setTick(t => t + 1))}>다시 불러오기</button>
        <button className="button" disabled={busy || loading || !dirty} onClick={save}>{busy ? "저장 중…" : "순서 저장"}</button></div>
    </div>
    <p className="muted">사용자에게 표시되는 공개 기본 예제만 나옵니다. 새 카테고리·강의는 저장된 순서 뒤에 추가됩니다. 강의 제목이나 본문은 변경되지 않습니다.</p>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {loading ? <p role="status">불러오는 중…</p> : edit && <>
      <p className="muted" role="status">{dirty ? "저장하지 않은 순서 변경이 있습니다." : "변경 내용이 없습니다."}</p>
      <div className="order-admin-grid">
        <section className="panel"><h3>카테고리 순서</h3>
          <ol className="order-list" aria-label="카테고리 노출 순서">{edit.categories.map((name, index) => <li key={name} className={selected === name ? "selected" : ""}>
            <button className="order-category" aria-pressed={selected === name} disabled={busy} onClick={() => setSelected(name)}>{name}<small>{edit.lessons[name].length}개 예제</small></button>
            <Position label={`${name} 카테고리`} index={index} count={edit.categories.length} disabled={busy} onMove={to => setEdit(v => ({ ...v, categories: moveItem(v.categories, index, to) }))} />
          </li>)}</ol>
          {!edit.categories.length && <p className="empty">공개된 기본 예제가 없습니다.</p>}
        </section>
        <section className="panel"><h3>{selected ? `${selected} · 강의 순서` : "강의 순서"}</h3>
          <ol className="order-list" aria-label="강의 노출 순서">{lessons.map((id, index) => {
            const post = examples.find(p => p.id === id);
            return <li key={id}><div className="order-lesson">{post?.thumbnail && <img src={`/api/post-images/${post.thumbnail.id}`} alt="" />}
              <span>{post?.title || id}</span></div>
              <Position label={`${post?.title || id} 강의`} index={index} count={lessons.length} disabled={busy} onMove={to => setEdit(v => ({ ...v, lessons: { ...v.lessons, [selected]: moveItem(v.lessons[selected], index, to) } }))} />
            </li>;
          })}</ol>
          {!selected && <p className="empty">카테고리를 선택해 주세요.</p>}
        </section>
      </div>
    </>}
  </section>;
}
