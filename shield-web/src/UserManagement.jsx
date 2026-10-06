import React, { useEffect, useState } from "react";
import { request, csv } from "./api";
import { number, date } from "./components";
export function UserStats({ tick }) {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const a = new AbortController();
    setData(null);
    setError("");
    request("/admin/user-summary", { signal: a.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => a.abort();
  }, [tick]);
  return (
    <>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="user-stats">
        {[
          ["total", "전체 결제 금액"],
          ["today", "오늘 결제 금액"],
          ["month", "이번 달 결제 금액"],
          ["users", "전체 사용자 수"],
        ].map(([k, label]) => (
          <article className="panel" key={k}>
            <p>{label}</p>
            <strong>
              {k !== "users" ? "₩ " : ""}
              {data ? number(data[k], 0) : error ? "—" : "…"}
              {k === "users" ? "명" : ""}
            </strong>
          </article>
        ))}
      </div>
      <p className="muted">
        승인된 포인트 결제 기준 · 한국 시간 · 관리자 포인트 조정은 결제 금액에서
        제외됩니다.
      </p>
    </>
  );
}
export const reception = (u) =>
  !u.device_count
    ? "장치 없음"
    : u.online_count === u.device_count
      ? "온라인"
      : u.online_count
        ? "일부 오프라인"
        : "오프라인";
export function exportUsers(rows) {
  const text = csv([
    [
      "이름",
      "이메일",
      "역할",
      "계정 상태",
      "장치 수",
      "수신 상태",
      "USIM 수",
      "데이터 잔량(MB,최근 조회값)",
      "잔량 조회 시각",
      "포인트",
      "누적 결제(원)",
      "가입일",
    ],
    ...rows.map((u) => [
      u.display_name,
      u.email,
      u.role,
      u.disabled ? "중지" : "활성",
      u.device_count,
      reception(u),
      u.sim_count,
      u.remaining_mb,
      u.quota_checked_at,
      u.credit_balance,
      u.paid_total,
      u.created_at,
    ]),
  ]);
  const url = URL.createObjectURL(
      new Blob([text], { type: "text/csv;charset=utf-8" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = "shield-users-current-page.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function UserDetail({ user, close }) {
  const [data, setData] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const a = new AbortController();
    setData(null);
    setError("");
    request(`/admin/users/${user.id}/detail`, { signal: a.signal })
      .then(setData)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => a.abort();
  }, [user.id]);
  return (
    <section className="panel user-detail">
      <div className="panel-title">
        <h2>
          {user.display_name} · {user.email}
        </h2>
        <button onClick={close}>닫기</button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p role="status">불러오는 중…</p>}
      {data && (
        <>
          <h3>소유 장치 · 최근 100대</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>장치</th>
                  <th>최근 수신</th>
                  <th>USIM</th>
                  <th>남은 데이터</th>
                  <th>잔량 조회 시각</th>
                </tr>
              </thead>
              <tbody>
                {data.devices.map((d) => (
                  <tr key={d.id}>
                    <td>{d.name}</td>
                    <td>{date(d.last_seen_at)}</td>
                    <td>{d.last4 ? "···· " + d.last4 : "미연결"}</td>
                    <td>{number(d.usage?.remaining_mb, 2)} MB</td>
                    <td>{date(d.checked_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.devices.length && (
            <p className="empty">등록된 장치가 없습니다.</p>
          )}
          <h3>포인트 결제 · 최근 100건</h3>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>주문 번호</th>
                  <th>금액</th>
                  <th>상태</th>
                  <th>결제 시각</th>
                </tr>
              </thead>
              <tbody>
                {data.payments.map((p) => (
                  <tr key={p.id}>
                    <td>{p.id}</td>
                    <td>₩{number(p.amount, 0)}</td>
                    <td>
                      {
                        {
                          paid: "완료",
                          pending: "결제 전",
                          confirming: "확인 중",
                          unknown: "결과 확인 필요",
                        }[p.status]
                      }
                    </td>
                    <td>{date(p.paid_at || p.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!data.payments.length && (
            <p className="empty">결제 내역이 없습니다.</p>
          )}
        </>
      )}
    </section>
  );
}
