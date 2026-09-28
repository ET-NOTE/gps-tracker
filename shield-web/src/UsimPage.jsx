import React, { useContext, useEffect, useRef, useState } from "react";
import { request } from "./api";
import { Session } from "./session";
import { Intro, Metric, date, number } from "./components";
export const states = {
  pending: "접수",
  approved: "승인 · 전송 전",
  submitting: "통신사 전송 중",
  submitted: "주문 접수 · 확인 대기",
  unknown: "결과 확인 필요",
  failed: "통신사 거절 · 환불",
  rejected: "반려 · 환불",
  cancelled: "취소 · 환불",
  completed: "처리 확인 완료",
};
export default function UsimPage() {
  const requestKey = useRef(crypto.randomUUID());
  const { user, reload } = useContext(Session);
  const [devices, setDevices] = useState([]),
    [id, setId] = useState(""),
    [sim, setSim] = useState(null),
    [rows, setRows] = useState([]),
    [credits, setCredits] = useState([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [tick, setTick] = useState(0),
    [history, setHistory] = useState(null),
    [agree, setAgree] = useState(false);
  useEffect(() => {
    const a = new AbortController();
    request("/devices", { signal: a.signal })
      .then((d) => {
        setDevices(d);
        setId(String(d[0]?.id || ""));
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => a.abort();
  }, []);
  useEffect(() => {
    setSim(null);
    setAgree(false);
    setHistory(null);
    requestKey.current = crypto.randomUUID();
  }, [id]);
  useEffect(() => {
    if (!id) return;
    const a = new AbortController();
    Promise.all([
      request(`/devices/${id}/usim`, { signal: a.signal }),
      request("/sim-requests", { signal: a.signal }),
      request("/credits", { signal: a.signal }),
    ])
      .then(([s, r, c]) => {
        setSim(s);
        setRows(r);
        setCredits(c);
        setError("");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => a.abort();
  }, [id, tick]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setTick((t) => t + 1);
    }, 15000);
    return () => clearInterval(timer);
  }, []);
  async function act(path, body, success) {
    setBusy(true);
    setError("");
    try {
      await request(path, { method: "POST", body });
      if (path === "/sim-requests") {
        requestKey.current = crypto.randomUUID();
        setAgree(false);
      }
      setNotice(success);
      setTick((t) => t + 1);
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const s = sim?.sim,
    usage = s?.usage,
    selected = devices.find((d) => String(d.id) === id);
  const open = rows.some(
    (r) =>
      r.device_id === Number(id) &&
      ["pending", "approved", "submitting", "submitted", "unknown"].includes(
        r.status,
      ),
  );
  return (
    <main className="container">
      <Intro
        title="내 USIM"
        description="장치의 데이터 잔량과 충전 요청·포인트 내역을 확인하세요."
      />
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
      <section className="panel device-toolbar">
        <label>
          디바이스
          <select
            aria-label="USIM 장치 선택"
            value={id}
            onChange={(e) => setId(e.target.value)}
          >
            {devices.length ? (
              devices.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.display_name}
                </option>
              ))
            ) : (
              <option value="">등록된 장치 없음</option>
            )}
          </select>
        </label>
        <strong>
          {s?.last4 ? `USIM ···· ${s.last4}` : "연결된 USIM 없음"}
        </strong>
        <button
          className="outline"
          disabled={busy || !s?.linked || !sim?.provider.configured}
          onClick={() =>
            act(
              `/devices/${id}/usim/refresh`,
              {},
              "잔량 갱신을 요청했습니다. 통신사 조회는 최소 5분 간격으로 실행됩니다.",
            )
          }
        >
          잔량 새로고침
        </button>
      </section>
      <div className="metrics">
        <Metric
          icon="sim"
          label="남은 데이터"
          value={number(usage?.remaining_mb, 2)}
          unit="MB"
          hint={
            usage ? `전체 ${number(usage.total_mb, 0)} MB` : "통신사 조회 대기"
          }
        />
        <Metric
          icon="signal"
          label="USIM 상태"
          value={
            { Enabled: "사용 중", Disabled: "비활성" }[usage?.status] ||
            usage?.status ||
            "확인 대기"
          }
          hint={
            usage?.expires_at
              ? `사용 기한 ${usage.expires_at}`
              : "통신사에서 확인된 정보만 표시합니다."
          }
        />
        <Metric
          icon="data"
          label="내 포인트"
          value={number(user.credit_balance, 0)}
          unit="P"
          hint="Shield 전용 잔액"
        />
      </div>
      {s?.error && !usage && (
        <p className="error" role="alert">
          {s.error}
        </p>
      )}
      {usage && (
        <section className="panel request-panel">
          <progress
            aria-label="남은 데이터 비율"
            max={usage.total_mb || 1}
            value={usage.remaining_mb}
          />
          <p className="muted">
            마지막 통신사 조회: {date(s.updated_at)} · 통신사 집계 지연이 있을
            수 있습니다.
          </p>
          {s.error && <p className="error">{s.error}</p>}
        </section>
      )}
      <section className="panel request-panel">
        <h2>USIM 데이터 충전 요청</h2>
        <p>
          {selected?.display_name || "장치 선택"} · 1회 500 MB ·{" "}
          {number(sim?.cost_credits, 0)} P
        </p>
        <p className="muted">
          접수 시 포인트를 차감하고 관리자가 확인 후 통신사에 주문합니다. 전송
          전 취소·반려 또는 통신사의 확정 거절은 환불됩니다. 결과 확인 중에는
          중복 주문하지 않습니다.
        </p>
        <label className="check-line">
          <input
            type="checkbox"
            checked={agree}
            onChange={(e) => setAgree(e.target.checked)}
          />
          대상 USIM과 포인트 차감 내용을 확인했습니다.
        </label>
        <button
          className="button"
          disabled={
            busy || !s?.linked || !agree || open || !sim?.provider.configured
          }
          onClick={() =>
            act(
              "/sim-requests",
              { device_id: Number(id), idempotency_key: requestKey.current },
              "충전 요청을 접수했습니다.",
            )
          }
        >
          {open ? "진행 중인 요청이 있습니다" : "충전 요청 접수"}
        </button>
      </section>
      <section className="panel history">
        <h2>충전 요청 내역</h2>
        <p className="muted">
          최근 100개 요청에서 선택한 장치의 내역을 표시합니다.
        </p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {["요청", "장치 / SIM", "상태", "포인트", "시각", "관리"].map(
                  (s) => (
                    <th key={s}>{s}</th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((r) => r.device_id === Number(id))
                .map((r) => (
                  <tr key={r.id}>
                    <td>#{r.id}</td>
                    <td>
                      {r.device_name} / ···· {r.last4}
                    </td>
                    <td>
                      {states[r.status]}
                      <small className="block">{r.admin_note}</small>
                    </td>
                    <td>{number(r.cost_credits, 0)} P</td>
                    <td>{date(r.created_at)}</td>
                    <td>
                      <button
                        onClick={async () => {
                          try {
                            setHistory(
                              await request(`/sim-requests/${r.id}/history`),
                            );
                          } catch (e) {
                            setError(e.message);
                          }
                        }}
                      >
                        이력
                      </button>
                      {r.status === "pending" && (
                        <button
                          disabled={busy}
                          onClick={() =>
                            act(
                              `/sim-requests/${r.id}/action`,
                              { action: "cancel" },
                              "요청을 취소하고 포인트를 환불했습니다.",
                            )
                          }
                        >
                          취소
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
        {!rows.some((r) => r.device_id === Number(id)) && (
          <p className="empty">아직 충전 요청이 없습니다.</p>
        )}
        {history && (
          <div className="notice">
            <button onClick={() => setHistory(null)}>이력 닫기</button>
            {history.map((e, i) => (
              <p key={i}>
                {date(e.created_at)} · {e.event} · {e.detail.note || ""}
              </p>
            ))}
          </div>
        )}
      </section>
      <section className="panel history">
        <h2>포인트 장부</h2>
        <p className="muted">최근 100건</p>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                {["시각", "구분", "변동", "잔액", "사유"].map((s) => (
                  <th key={s}>{s}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {credits.map((e) => (
                <tr key={e.id}>
                  <td>{date(e.created_at)}</td>
                  <td>
                    {
                      {
                        adjustment: "관리자 조정",
                        charge: "요청 차감",
                        refund: "환불",
                      }[e.kind]
                    }
                  </td>
                  <td>{number(e.amount, 0)} P</td>
                  <td>{number(e.balance_after, 0)} P</td>
                  <td>{e.note}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!credits.length && <p className="empty">포인트 내역이 없습니다.</p>}
      </section>
    </main>
  );
}
