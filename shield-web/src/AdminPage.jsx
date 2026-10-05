import useEditProtection from "./useEditProtection";
import { FaqAdmin } from "./FaqPage";
import {
  UserStats,
  UserDetail,
  reception,
  exportUsers,
} from "./UserManagement";
import React, { useContext, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { request, query } from "./api";
import { Session } from "./session";
import { usePosts } from "./posts";
import { Intro, date, number } from "./components";
import { states } from "./UsimPage";
import PostEditor from "./PostEditor";
import CategoryAdmin from "./CategoryAdmin";
import LibraryOrderAdmin from "./LibraryOrderAdmin";
const tabs = {
  overview: "운영 현황",
  posts: "예제·가이드",
  categories: "카테고리",
  ordering: "노출 순서",
  faqs: "FAQ 관리",
  users: "사용자",
  devices: "장치·USIM",
  requests: "충전 요청",
  credits: "포인트 장부",
  audit: "감사 기록",
};
const paths = {
  overview: "/admin/overview",
  posts: "/admin/posts",
  users: "/admin/users",
  devices: "/admin/devices",
  requests: "/sim-requests",
  credits: "/credits",
  audit: "/admin/audit",
};
const emptyPost = {
  content: {
    id: "",
    title: "",
    description: "",
    category: "센서",
    level: "기초",
    minutes: 15,
    variant: "sensor",
    steps: [""],
    code: "",
  },
  published: false,
  revision: 0,
};
export default function AdminPage() {
  const { user, reload } = useContext(Session),
    posts = usePosts();
  const [tab, setTab] = useState("overview"),
    [data, setData] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0),
    [before, setBefore] = useState(null),
    [search, setSearch] = useState(""),
    [settledSearch, setSettledSearch] = useState(""),
    [status, setStatus] = useState("all"),
    [viewUser, setViewUser] = useState(null),
    [edit, setEdit] = useState(null),
    [secret, setSecret] = useState(null),
    [details, setDetails] = useState(null),
    [editorVersion, setEditorVersion] = useState(0),
    [uploadBusy, setUploadBusy] = useState(false),
    [faqStatus, setFaqStatus] = useState({ dirty: false, busy: false });
  useEffect(() => {
    const timer = setTimeout(() => setSettledSearch(search), 250);
    return () => clearTimeout(timer);
  }, [search]);
  const editInitial = useRef(null);
  const dirty = !!edit && JSON.stringify(edit) !== editInitial.current;
  const protection = useEditProtection({
    dirty: dirty || uploadBusy || faqStatus.dirty,
    busy: busy || faqStatus.busy,
  });
  function openEdit(next) {
    protection.leave(() => {
      editInitial.current = JSON.stringify(next);
      setEditorVersion((v) => v + 1);
      setEdit(next);
    });
  }
  function changeTab(key) {
    if (key === tab) return;
    protection.leave(() => {
      setData(null);
      setEdit(null);
      setTab(key);
      setBefore(null);
      setSearch("");
      setSettledSearch("");
      setStatus("all");
      setNotice("");
      setSecret(null);
    });
  }
  useEffect(() => {
    setData(null);
    setBefore(null);
    setEdit(null);
    setDetails(null);
    setViewUser(null);
    setError("");
  }, [tab]);
  useEffect(() => {
    if (user?.role !== "admin" || ["faqs", "categories", "ordering"].includes(tab)) return;
    const a = new AbortController();
    setData(null);
    setError("");
    request(
      paths[tab] +
        "?" +
        query({
          before,
          q: tab === "users" ? settledSearch : undefined,
          status: tab === "users" ? status : undefined,
          all: tab === "credits",
        }),
      {
        signal: a.signal,
      },
    )
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e.message);
          if ([401, 403].includes(e.status)) reload();
        }
      });
    return () => a.abort();
  }, [tab, before, settledSearch, status, tick, user?.role, reload]);
  async function mutate(
    path,
    body,
    success = "저장했습니다.",
    { closeEditor = true } = {},
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await request(path, { method: "POST", body });
      setNotice(success);
      setTick((v) => v + 1);
      if (closeEditor) setEdit(null);
      if (path.startsWith("/admin/posts/") || path === "/admin/site-settings")
        await posts.reload();
      return result;
    } catch (e) {
      setError(e.message);
      return null;
    } finally {
      setBusy(false);
    }
  }
  if (user?.role !== "admin")
    return (
      <main className="container empty">
        <h1>관리자 권한이 필요합니다.</h1>
        <Link to="/data">내 데이터로 이동</Link>
      </main>
    );
  const rows = Array.isArray(data) ? data : [];
  return (
    <main className="container admin-page">
      {protection.prompt}
      <Intro
        title="관리"
        description="게시물과 계정, 장치 및 USIM 운영 이력을 관리합니다."
      />
      <nav className="tabs admin-tabs" aria-label="관리 메뉴">
        {Object.entries(tabs).map(([key, label]) => (
          <button
            key={key}
            className={key === tab ? "active" : ""}
            aria-pressed={key === tab}
            disabled={busy || faqStatus.busy}
            onClick={() => changeTab(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {tab === "users" && <UserStats tick={tick} />}
      {tab === "faqs" && (
        <FaqAdmin requestLeave={protection.leave} onStatus={setFaqStatus} />
      )}
      {tab === "categories" && <CategoryAdmin requestLeave={protection.leave} onStatus={setFaqStatus} />}
      {tab === "ordering" && <LibraryOrderAdmin requestLeave={protection.leave} onStatus={setFaqStatus} />}
      <div className="admin-toolbar" hidden={["faqs", "categories", "ordering"].includes(tab)}>
        <button
          className="outline"
          onClick={() => {
            setBefore(null);
            setTick((t) => t + 1);
          }}
        >
          새로고침
        </button>
        {tab === "posts" && (
          <button
            className="button"
            disabled={busy}
            onClick={() => openEdit(structuredClone(emptyPost))}
          >
            게시물 추가
          </button>
        )}
        {tab === "users" && (
          <>
            <input
              maxLength={100}
              aria-label="사용자 검색"
              placeholder="이메일·이름 검색"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setBefore(null);
              }}
            />
            <select
              aria-label="사용자 상태"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setBefore(null);
              }}
            >
              <option value="all">전체 상태</option>
              <option value="active">활성</option>
              <option value="disabled">이용 중지</option>
              <option value="admin">관리자</option>
            </select>
            <button
              className="outline"
              disabled={!rows.length}
              onClick={() => exportUsers(rows)}
            >
              현재 목록 CSV 다운로드
            </button>
            <button
              className="outline"
              disabled={busy}
              onClick={async () => {
                const r = await mutate(
                  "/admin/invites",
                  {},
                  "초대코드를 발급했습니다.",
                  { closeEditor: false },
                );
                if (r) setSecret(r);
              }}
            >
              + 사용자 초대
            </button>
          </>
        )}
      </div>
      {secret && (
        <section className="panel">
          <h2>한 번만 표시되는 초대코드</h2>
          <p>7일 동안 한 번 사용할 수 있습니다. 전달할 때만 복사해 주세요.</p>
          <code className="secret-code">{secret.invite_code}</code>
          <button onClick={() => setSecret(null)}>닫기</button>
        </section>
      )}
      {!["faqs", "categories", "ordering"].includes(tab) && data === null && !error && (
        <p role="status" className="notice">
          불러오는 중…
        </p>
      )}
      {tab === "overview" && data?.counts && (
        <>
          <div className="metrics">
            {Object.entries({
              users: "사용자",
              devices: "장치",
              reports_today: "오늘 수신",
              open_requests: "처리 대기",
              posts: "예제·가이드",
              faqs: "FAQ 관리",
            }).map(([k, label]) => (
              <article className="metric" key={k}>
                <div>
                  <p>{label}</p>
                  <strong>{number(data.counts[k], 0)}</strong>
                </div>
              </article>
            ))}
          </div>
          <section className="panel">
            <h2>1NCE 연결</h2>
            <p>
              조회: {data.provider.configured ? "설정됨" : "설정 필요"} · 주문
              전송:{" "}
              {data.provider.topup_enabled ? "관리자 승인 후 가능" : "비활성화"}
            </p>
            <p className="muted">
              통신사 전송은 충전 요청의 상세 화면에서 요청 번호를 확인한 뒤
              실행합니다. 결과 확인 중인 요청은 재전송하지 않습니다.
            </p>
          </section>
        </>
      )}
      {tab === "posts" && (
        <section className="panel guide-setting">
          <label>
            시작가이드로 표시할 예제
            <select
              aria-label="시작가이드 예제 선택"
              value={posts.settings.guide_slug}
              disabled={busy || !data}
              onChange={(e) =>
                mutate(
                  "/admin/site-settings",
                  { guide_slug: e.target.value },
                  "시작가이드를 변경했습니다.",
                  { closeEditor: false },
                )
              }
            >
              {rows
                .filter(
                  (p) =>
                    p.published && (p.content.kind || "example") === "example",
                )
                .map((p) => (
                  <option key={p.content.id} value={p.content.id}>
                    {p.content.title}
                  </option>
                ))}
            </select>
          </label>
          <p className="muted">
            선택한 예제와 시작가이드는 같은 본문·사진·첨부파일을 사용합니다.
          </p>
        </section>
      )}
      {tab === "posts" && data !== null && !edit && (
        <div className="admin-posts">
          {rows.map((p) => (
            <article className="panel" key={p.content.id}>
              <div>
                <span className="badge">
                  {p.published ? "공개" : "초안"} · v{p.revision}
                </span>
                <h2>{p.content.title}</h2>
                <p>{p.content.description}</p>
                <small>{date(p.updated_at)}</small>
              </div>
              <button
                className="outline"
                onClick={() => openEdit(structuredClone(p))}
              >
                편집
              </button>
              <Link to={"/examples/" + p.content.id}>페이지 보기</Link>
            </article>
          ))}
        </div>
      )}
      {tab === "posts" && edit && (
        <PostEditor
          key={editorVersion}
          edit={edit}
          setEdit={setEdit}
          busy={busy}
          dirty={dirty}
          onUploadBusy={setUploadBusy}
          saveError={error}
          onClose={() => protection.leave(() => setEdit(null))}
          onSave={() =>
            mutate(
              `/admin/posts/${edit.content.id}`,
              {
                content: edit.content,
                published: edit.published,
                revision: edit.revision,
              },
              "게시물을 저장했습니다.",
            )
          }
        />
      )}
      {tab === "users" && data !== null && (
        <>
          <Table
            headings={[
              "사용자",
              "역할·계정",
              "장치·수신",
              "USIM·잔량",
              "포인트",
              "누적 결제",
              "가입일",
              "관리",
            ]}
          >
            {rows.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.email}
                  <small className="block">{u.display_name}</small>
                </td>
                <td>
                  {u.role === "admin" ? "관리자" : "사용자"}
                  <small className="block">
                    {u.disabled ? "이용 중지" : "활성"}
                  </small>
                </td>
                <td>
                  {u.device_count}대
                  <small className="block">{reception(u)}</small>
                </td>
                <td>
                  {u.sim_count}개
                  <small className="block">
                    {number(u.remaining_mb, 2)} MB
                  </small>
                  <small className="block">
                    {u.quota_checked_at
                      ? date(u.quota_checked_at)
                      : "잔량 조회 대기"}
                  </small>
                </td>
                <td>{number(u.credit_balance, 0)} P</td>
                <td>₩{number(u.paid_total, 0)}</td>
                <td>{date(u.created_at)}</td>
                <td>
                  <button onClick={() => setViewUser(u)}>보기</button>
                  <button onClick={() => openEdit({ ...u, kind: "user" })}>
                    수정
                  </button>
                  <button
                    onClick={() =>
                      openEdit({
                        ...u,
                        kind: "credit",
                        amount: 0,
                        note: "",
                        idempotency_key: crypto.randomUUID(),
                      })
                    }
                  >
                    포인트 조정
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      mutate(
                        `/admin/users/${u.id}/revoke`,
                        {},
                        "해당 사용자의 모든 세션을 종료했습니다.",
                      )
                    }
                  >
                    세션 종료
                  </button>
                </td>
              </tr>
            ))}
          </Table>
          {viewUser && (
            <UserDetail
              key={viewUser.id}
              user={viewUser}
              close={() => setViewUser(null)}
            />
          )}
          {edit?.kind === "user" && (
            <section className="panel editor">
              <h2>{edit.email}</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  mutate(`/admin/users/${edit.id}`, {
                    display_name: edit.display_name,
                    role: edit.role,
                    disabled: edit.disabled,
                  });
                }}
              >
                <label>
                  표시 이름
                  <input
                    maxLength={50}
                    required
                    value={edit.display_name}
                    onChange={(e) =>
                      setEdit({ ...edit, display_name: e.target.value })
                    }
                  />
                </label>
                <label>
                  역할
                  <select
                    value={edit.role}
                    onChange={(e) => setEdit({ ...edit, role: e.target.value })}
                  >
                    <option value="user">사용자</option>
                    <option value="admin">관리자</option>
                  </select>
                </label>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={edit.disabled}
                    onChange={(e) =>
                      setEdit({ ...edit, disabled: e.target.checked })
                    }
                  />
                  이용 중지
                </label>
                <p className="muted">
                  권한 변경이나 이용 중지는 기존 로그인을 종료합니다. 계정과
                  측정 기록은 보존됩니다.
                </p>
                <button className="button" disabled={busy}>
                  저장
                </button>
              </form>
            </section>
          )}
          {edit?.kind === "credit" && (
            <section className="panel editor">
              <h2>{edit.email} · 포인트 조정</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  mutate(`/admin/users/${edit.id}/credits`, {
                    amount: edit.amount,
                    note: edit.note,
                    idempotency_key: edit.idempotency_key,
                  });
                }}
              >
                <label>
                  변동 포인트 (차감은 음수)
                  <input
                    required
                    type="number"
                    min="-10000000"
                    max="10000000"
                    value={edit.amount}
                    onChange={(e) =>
                      setEdit({ ...edit, amount: Number(e.target.value) })
                    }
                  />
                </label>
                <label>
                  조정 사유
                  <input
                    required
                    maxLength={300}
                    value={edit.note}
                    onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                  />
                </label>
                <p className="notice">
                  현금 결제가 발생하지 않는 관리자 장부 조정입니다. 실제
                  수납·정정 근거를 남겨 주세요.
                </p>
                <button className="button" disabled={busy || !edit.amount}>
                  조정 기록
                </button>
              </form>
            </section>
          )}
        </>
      )}
      {tab === "devices" && data !== null && (
        <>
          <Table headings={["장치", "소유자", "최근 수신", "USIM", "관리"]}>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.display_name}
                  <small className="block">{d.device_uid}</small>
                </td>
                <td>{d.owner_email || "미등록"}</td>
                <td>{date(d.last_seen_at)}</td>
                <td>
                  {d.sim_iccid ? `···· ${d.sim_iccid.slice(-4)}` : "미연결"}
                  <small className="block">{d.sim_error}</small>
                </td>
                <td>
                  <button onClick={() => openEdit(d)}>수정</button>
                  <button
                    onClick={async () => {
                      try {
                        setDetails(await request(`/devices/${d.id}/usim`));
                      } catch (e) {
                        setError(e.message);
                      }
                    }}
                  >
                    잔량 조회
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      mutate(
                        `/devices/${d.id}/usim/refresh`,
                        {},
                        "통신사 갱신을 요청했습니다.",
                      )
                    }
                  >
                    잔량 갱신
                  </button>
                </td>
              </tr>
            ))}
          </Table>
          {edit && (
            <section className="panel editor">
              <h2>장치 정보 수정</h2>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  mutate(`/admin/devices/${edit.id}`, {
                    display_name: edit.display_name,
                    sim_iccid: edit.sim_iccid || null,
                  });
                }}
              >
                <label>
                  장치 이름
                  <input
                    required
                    maxLength={60}
                    value={edit.display_name}
                    onChange={(e) =>
                      setEdit({ ...edit, display_name: e.target.value })
                    }
                  />
                </label>
                <label>
                  장착 USIM 번호 (ICCID)
                  <input
                    inputMode="numeric"
                    pattern="[0-9]{19,20}"
                    value={edit.sim_iccid || ""}
                    onChange={(e) =>
                      setEdit({ ...edit, sim_iccid: e.target.value })
                    }
                  />
                </label>
                <p className="muted">
                  SIM 교체 시 이전 잔량 캐시를 지웁니다. 진행 중인 충전 요청이
                  있으면 교체할 수 없습니다.
                </p>
                <button className="button" disabled={busy}>
                  저장
                </button>
              </form>
            </section>
          )}
        </>
      )}
      {tab === "requests" && data !== null && (
        <>
          <Table
            headings={["요청", "사용자·장치", "USIM", "상태", "포인트", "관리"]}
          >
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  #{r.id}
                  <small className="block">{date(r.created_at)}</small>
                </td>
                <td>
                  {r.user_email}
                  <small className="block">{r.device_name}</small>
                </td>
                <td>···· {r.last4}</td>
                <td>{states[r.status]}</td>
                <td>{number(r.cost_credits, 0)} P</td>
                <td>
                  <button
                    onClick={() =>
                      openEdit({
                        ...r,
                        note: "",
                        confirm_reference: "",
                        order_id: r.provider_order_id || "",
                      })
                    }
                  >
                    처리
                  </button>
                  <button
                    onClick={async () => {
                      try {
                        setDetails(
                          await request(`/sim-requests/${r.id}/history`),
                        );
                      } catch (e) {
                        setError(e.message);
                      }
                    }}
                  >
                    이력
                  </button>
                </td>
              </tr>
            ))}
          </Table>
          {edit && (
            <section className="panel editor">
              <h2>
                충전 요청 #{edit.id} · {states[edit.status]}
              </h2>
              <p>
                {edit.user_email} · {edit.device_name} · USIM ···· {edit.last4}
              </p>
              <label>
                처리 메모
                <textarea
                  value={edit.note}
                  maxLength={500}
                  onChange={(e) => setEdit({ ...edit, note: e.target.value })}
                />
              </label>
              <div className="admin-actions">
                {edit.status === "pending" && (
                  <button
                    disabled={busy}
                    className="button"
                    onClick={() =>
                      mutate(
                        `/sim-requests/${edit.id}/action`,
                        { action: "approve", note: edit.note },
                        "승인했습니다. 아직 통신사에 전송하지 않았습니다.",
                      )
                    }
                  >
                    승인
                  </button>
                )}
                {["pending", "approved"].includes(edit.status) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      mutate(
                        `/sim-requests/${edit.id}/action`,
                        { action: "reject", note: edit.note },
                        "반려하고 포인트를 환불했습니다.",
                      )
                    }
                  >
                    반려·환불
                  </button>
                )}
              </div>
              {edit.status === "approved" && (
                <div className="notice">
                  <strong>실제 1NCE 충전 주문</strong>
                  <p>
                    이 작업은 통신사 비용을 발생시킬 수 있습니다. 대상 SIM을
                    확인하고 아래 요청 번호를 입력하세요.
                  </p>
                  <code>{edit.reference}</code>
                  <label>
                    요청 번호 확인
                    <input
                      value={edit.confirm_reference}
                      onChange={(e) =>
                        setEdit({ ...edit, confirm_reference: e.target.value })
                      }
                    />
                  </label>
                  <button
                    className="button"
                    disabled={busy || edit.confirm_reference !== edit.reference}
                    onClick={() =>
                      mutate(
                        `/sim-requests/${edit.id}/action`,
                        {
                          action: "execute",
                          note: edit.note,
                          confirm_reference: edit.confirm_reference,
                        },
                        "통신사에 한 번 전송합니다. 요청 상태를 확인해 주세요.",
                      )
                    }
                  >
                    1NCE에 충전 주문 전송
                  </button>
                </div>
              )}
              {["unknown", "submitted", "submitting"].includes(edit.status) && (
                <div className="notice">
                  <p>
                    재전송하지 않습니다. 통신사에서 주문을 확인한 뒤 해당 주문
                    번호와 확인 근거를 기록하세요.
                  </p>
                  <label>
                    통신사 주문 번호
                    <input
                      value={edit.order_id}
                      onChange={(e) =>
                        setEdit({ ...edit, order_id: e.target.value })
                      }
                    />
                  </label>
                  <button
                    disabled={busy || !edit.order_id || !edit.note.trim()}
                    onClick={() =>
                      mutate(
                        `/sim-requests/${edit.id}/action`,
                        {
                          action: "reconcile",
                          note: edit.note,
                          order_id: edit.order_id,
                        },
                        "해당 USIM의 통신사 주문을 조회하고 확인 기록을 남겼습니다.",
                      )
                    }
                  >
                    주문 조회 후 처리 확인
                  </button>
                </div>
              )}
            </section>
          )}
        </>
      )}
      {tab === "credits" && data !== null && (
        <Table headings={["시각", "사용자", "구분", "변동", "잔액", "사유"]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{date(r.created_at)}</td>
              <td>{r.user_email}</td>
              <td>{r.kind}</td>
              <td>{number(r.amount, 0)}</td>
              <td>{number(r.balance_after, 0)}</td>
              <td>{r.note}</td>
            </tr>
          ))}
        </Table>
      )}
      {tab === "audit" && data !== null && (
        <Table headings={["시각", "담당자", "작업", "대상", "상세"]}>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{date(r.created_at)}</td>
              <td>{r.actor}</td>
              <td>{r.action}</td>
              <td>
                {r.target_type} / {r.target_id}
              </td>
              <td>
                <button onClick={() => setDetails(r.detail)}>변경 내용</button>
              </td>
            </tr>
          ))}
        </Table>
      )}
      {details && (
        <section className="panel">
          <div className="panel-title">
            <h2>상세 기록</h2>
            <button onClick={() => setDetails(null)}>닫기</button>
          </div>
          <pre className="audit-detail">{JSON.stringify(details, null, 2)}</pre>
        </section>
      )}
      {data !== null && !["posts", "overview", "faqs", "categories", "ordering"].includes(tab) && (
        <div className="pagination">
          <span>{rows.length}건 표시</span>
          <button disabled={!before} onClick={() => setBefore(null)}>
            처음
          </button>
          <button
            disabled={rows.length < 100}
            onClick={() => setBefore(rows.at(-1).id)}
          >
            이전 기록 더 보기
          </button>
        </div>
      )}
    </main>
  );
}
function Table({ headings, children }) {
  return (
    <section className="panel history">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              {headings.map((h) => (
                <th key={h}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {React.Children.count(children) === 0 && (
        <p className="empty">표시할 기록이 없습니다.</p>
      )}
    </section>
  );
}
