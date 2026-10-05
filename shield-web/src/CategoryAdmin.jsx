import React, { useEffect, useRef, useState } from "react";
import { request } from "./api";
import { usePosts } from "./posts";
import { featuredLessons } from "./lessonContent";
import { CategoryCard, categoryGroups } from "./LibraryPages";
import ThumbnailPicker from "./ThumbnailPicker";

export default function CategoryAdmin({ requestLeave, onStatus }) {
  const { posts, settings, reload } = usePosts();
  const [rows, setRows] = useState([]), [edit, setEdit] = useState(null), [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [uploading, setUploading] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const initial = useRef(""), selected = useRef("");
  const dirty = !!edit && JSON.stringify(edit) !== initial.current;
  const groups = categoryGroups(featuredLessons(posts, settings.guide_slug));
  for (const row of rows) if (!groups.some(g => g.name === row.category)) groups.push({ name: row.category, count: 0, icon: "book", description: "현재 공개된 예제가 없습니다." });
  useEffect(() => { onStatus({ dirty: dirty || uploading, busy }); }, [dirty, uploading, busy, onStatus]);
  useEffect(() => () => onStatus({ dirty: false, busy: false }), [onStatus]);
  useEffect(() => {
    const abort = new AbortController(); setLoading(true); setError("");
    request("/admin/category-thumbnails", { signal: abort.signal }).then(next => {
      setRows(next);
      if (selected.current) {
        const current = next.find(r => r.category === selected.current) || { category: selected.current, thumbnail: null, revision: 0 };
        initial.current = JSON.stringify(current); setEdit(current);
      }
    }).catch(e => { if (e.name !== "AbortError") setError(e.message); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [tick]);
  function choose(category) {
    requestLeave(() => {
      const current = structuredClone(rows.find(r => r.category === category) || { category, thumbnail: null, revision: 0 });
      selected.current = category; initial.current = JSON.stringify(current); setEdit(current); setError(""); setNotice("");
    });
  }
  async function save(e) {
    e.preventDefault(); if (busy || uploading || loading || !edit) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const next = await request("/admin/category-thumbnails", { method: "POST", body: edit });
      initial.current = JSON.stringify(next); setEdit(next);
      setRows(old => [...old.filter(r => r.category !== next.category), next]);
      setNotice("카테고리 썸네일을 저장했습니다."); await reload();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  return <section className="category-admin">
    <div className="section-heading"><div><h2>카테고리 썸네일</h2><p>게시물에 지정된 분류별로 목록 대표 사진을 설정합니다.</p></div>
      <button className="outline" disabled={busy} onClick={() => requestLeave(() => setTick(t => t + 1))}>다시 불러오기</button></div>
    {loading && <p role="status">불러오는 중…</p>}
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="notice" role="status">{notice}</p>}
    <div className="tabs category-admin-tabs" aria-label="편집할 카테고리">{groups.map(g => <button key={g.name} disabled={busy || loading}
      aria-pressed={edit?.category === g.name} onClick={() => choose(g.name)}>{g.name}</button>)}</div>
    {!edit ? <p className="empty">썸네일을 편집할 카테고리를 선택해 주세요.</p> :
      <div className="thumbnail-admin-grid">
        <form className="panel" onSubmit={save}><h2>{edit.category}</h2>
          <fieldset disabled={busy || loading}>
            <ThumbnailPicker key={edit.category + ':' + tick} label="카테고리 썸네일" value={edit.thumbnail}
              onChange={thumbnail => setEdit(e => ({ ...e, thumbnail }))} onBusy={setUploading} disabled={busy || loading} />
            <button className="button" disabled={!dirty || uploading || busy || loading}>카테고리 저장</button>
          </fieldset>
          <p className="muted" role="status">{dirty ? "저장하지 않은 변경 내용이 있습니다." : "변경 내용이 없습니다."}</p>
        </form>
        <aside><p className="muted">사용자 화면 · 저장 전 미리보기</p>
          <CategoryCard category={groups.find(g => g.name === edit.category) || { name: edit.category, count: 0, icon: "book", description: "현재 공개된 예제가 없습니다." }} thumbnail={edit.thumbnail} preview />
        </aside>
      </div>}
  </section>;
}
